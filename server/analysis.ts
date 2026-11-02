import { sourceIdentity } from '../shared/review-workflow.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  ANALYZER_VERSION,
  SQL_ANALYSIS_VERSION,
  TEST_ANALYSIS_VERSION,
  emptyModelResult,
  type AnalysisRun,
  type ReviewSession,
  type ProgressEvent,
  type DatabaseOperation,
  type IndexedMethod,
} from '../shared/model.js';
import { storedIndex } from './indexer.js';
import { extractContracts } from './contracts.js';
import { attachBuilds } from './contract-builds.js';
import { changeCards } from './change-cards.js';
import { changeUnits } from '../shared/change-units.js';
import { errorMessage } from '../shared/errors.js';
import { optionalSteps, type OptionalStep } from '../shared/analysis-steps.js';
import { readSource } from './repository.js';
import { validateModelResult } from './validation.js';
import type { AnalysisInput, AnalysisProvider } from './provider.js';
import { AnalysisMeasurements } from './analysis-statistics.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { archiveReview } from './revisions.js';
import { mergeIncremental, affectedPrevious, stableArtifactIds } from './incremental.js';
import { reviewScopeSnapshots } from '../shared/analysis-scope.js';
import { scenarioRoots, missingScenarios, type ScenarioRoot } from '../shared/scenario-coverage.js';
import {
  missingSqlMethods,
  queryMatchesMethod,
  queryMethodName,
  sqlMethods,
} from '../shared/sql-coverage.js';
import {
  missingTestMethods,
  reviewTestMethods,
  testMatchesMethod,
} from '../shared/test-coverage.js';
import { startsLike, t, tc } from '../shared/i18n.js';

const TEST_BATCH = 40;
type TokenTotals = NonNullable<AnalysisRun['usage']>;
/** Notes about an earlier interrupted attempt; a run that continues the work drops them. */
export const withoutRunFailures = (gaps: string[]) =>
  gaps.filter(
    (gap) =>
      !startsLike(gap, 'Codex/analysis: {0}') &&
      !startsLike(gap, 'Analysis cancelled by the user.') &&
      !startsLike(gap, 'Analysis interrupted by a restart'),
  );
/** Codex reports thread totals on turn.completed, although the SDK documents them as per turn. */
export function tokensSince(previous: TokenTotals | undefined, total: TokenTotals): TokenTotals {
  if (!previous || total.input < previous.input) return total;
  return {
    input: total.input - previous.input,
    cached: Math.max(0, total.cached - previous.cached),
    output: Math.max(0, total.output - previous.output),
  };
}
/** A line inside a query method, as the SQL panel knows it. */
export interface SqlMethodRef {
  repoId: string;
  side: 'head' | 'base';
  path: string;
  line: number;
}
export class AnalysisManager {
  private measurements: AnalysisMeasurements;
  private jobs = new Map<string, AbortController>();
  private activeSessions = new Map<string, ReviewSession>();
  private executions = new Set<Promise<void>>();
  private subscribers = new Map<string, Set<(event: ProgressEvent) => void>>();
  constructor(
    private store: Store,
    private provider: AnalysisProvider,
  ) {
    this.measurements = new AnalysisMeasurements(store);
  }
  /** A stage that does not run with the review: switched off, or run on request per method. */
  private disabled(step: OptionalStep) {
    return (
      this.store.disabledSteps().includes(step) ||
      (this.store.onDemandSteps() as OptionalStep[]).includes(step)
    );
  }
  /** Gaps a run must not count as missing work: the stages it skipped by the settings. */
  private skipped(run: AnalysisRun, step: OptionalStep) {
    return !!run.skippedSteps?.includes(step);
  }
  private async analyzeModel(
    session: ReviewSession,
    run: AnalysisRun,
    input: AnalysisInput,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) {
    run.checkpoint ??= {
      stage: input.testsOnly
        ? 'tests'
        : input.sqlOnly
          ? 'sql'
          : input.scenariosOnly
            ? 'scenarios'
            : 'review',
    };
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          session.snapshots.map((snapshot) => [
            snapshot.repoId,
            sourceIdentity(snapshot),
            sourceIdentity(snapshot, 'base'),
          ]),
          input.testsOnly,
          input.sqlOnly,
          input.scenariosOnly,
          input.testTargets,
          input.sqlTargets,
          input.followUp,
        ]),
      )
      .digest('hex');
    if (
      run.checkpoint.pending &&
      !run.checkpoint.pending.keyVersion &&
      run.fingerprint === this.fingerprint(session)
    ) {
      run.checkpoint.pending.key = key;
      run.checkpoint.pending.keyVersion = 2;
    }
    if (run.checkpoint.pending && run.checkpoint.pending.key !== key)
      throw new AppError(
        t(
          'The saved request belongs to another part of the analysis. Continuation stopped; results are saved.',
        ),
        409,
      );
    // Each stage starts a fresh Codex thread in the shared workspace: resuming the previous
    // stage's thread re-sent its whole transcript on every request of the next one.
    const pending = (run.checkpoint.pending ??= {
      key,
      keyVersion: 2,
      ...(input.testTargets ? { testTargets: input.testTargets } : {}),
      ...(input.sqlTargets ? { sqlTargets: input.sqlTargets } : {}),
      ...(run.conversation ? { home: run.conversation.home } : {}),
    });
    this.store.saveSession(session);
    if (pending.result) return pending.result;
    const metric = this.measurements.request(
      session.id,
      input.testsOnly
        ? 'tests'
        : input.sqlOnly
          ? 'sql'
          : input.scenariosOnly
            ? 'scenarios'
            : 'review',
      input.testTargets?.length ?? input.sqlTargets?.length ?? input.scenariosOnly?.length,
    );
    try {
      const result = await this.provider.analyze(
        {
          ...input,
          userMessages: (run.messages ?? []).map((message) => message.text),
          continuation: { checkpoint: pending, save: () => this.store.saveSession(session) },
          onEvent: (event) => {
            if (event.type === 'turn.completed') {
              const total = {
                input: event.usage.input_tokens,
                cached: event.usage.cached_input_tokens,
                output: event.usage.output_tokens,
              };
              const spent = tokensSince(pending.usageTotal, total);
              this.measurements.usage(session.id, metric, spent);
              pending.usageTotal = total;
              const usage = (run.usage ??= { input: 0, cached: 0, output: 0 });
              usage.input += spent.input;
              usage.cached += spent.cached;
              usage.output += spent.output;
              this.event(
                session,
                run,
                t(
                  'Stage tokens: input {0}, cached {1}, output {2}.',
                  spent.input,
                  spent.cached,
                  spent.output,
                ),
                'usage',
              );
            }
            if (
              event.type !== 'item.started' &&
              event.type !== 'item.completed' &&
              event.type !== 'item.updated'
            )
              return;
            const item = event.item;
            if (item.type === 'agent_message' && event.type === 'item.completed') {
              try {
                JSON.parse(item.text);
              } catch {
                this.event(session, run, item.text, 'assistant');
              }
            }
            if (item.type === 'command_execution' && event.type === 'item.started')
              this.event(session, run, item.command.slice(0, 2000), 'tool');
            if (item.type === 'command_execution' && event.type === 'item.completed')
              this.event(
                session,
                run,
                `${item.command.slice(0, 1500)}\n${item.aggregated_output.slice(0, 4000)}${item.aggregated_output.length > 4000 ? t('\n… output truncated') : ''}`,
                'tool',
              );
            if (item.type === 'todo_list') {
              const plan = item.items
                .map((task) => `${task.completed ? '✓' : '○'} ${task.text}`)
                .join('\n');
              const last = run.events.filter((e) => e.kind === 'plan').at(-1);
              if (last?.message !== plan) this.event(session, run, plan, 'plan');
            }
          },
        },
        signal,
        progress,
      );
      pending.result = result;
      this.store.saveSession(session);
      this.measurements.finishRequest(session.id, metric);
      return result;
    } catch (error) {
      this.measurements.finishRequest(session.id, metric, error, signal.aborted);
      throw error;
    }
  }
  private async commitModel(session: ReviewSession, run: AnalysisRun) {
    const pending = run.checkpoint?.pending;
    if (pending?.home && pending.localWorkspace) run.conversation = { home: pending.home };
    if (run.checkpoint) delete run.checkpoint.pending;
    this.store.saveSession(session);
  }
  private previousFingerprint(
    session: ReviewSession,
    version: string,
    providerId = this.provider.id,
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          version,
          providerId,
          process.env.REVIEW_CODEX_MODEL ?? 'default',
          session.snapshots.map((s) => [
            s.repoId,
            s.headSha,
            s.mergeBase,
            s.pr?.number,
            s.pr?.title,
            s.pr?.body,
          ]),
          ...(session.update ? [session.update] : []),
        ]),
      )
      .digest('hex');
  }
  private legacyScope(session: ReviewSession) {
    const run = session.run;
    return (
      !!run &&
      ((run.version === '0.2.0-local-scope' &&
        (run.fingerprint === this.fingerprint(session, run.version) ||
          run.fingerprint === this.previousFingerprint(session, run.version))) ||
        (run.version === '0.1.0' &&
          (run.fingerprint === this.fingerprint(session, run.version, 'codex-sdk-v4-tests') ||
            run.fingerprint ===
              this.previousFingerprint(session, run.version, 'codex-sdk-v4-tests'))))
    );
  }
  private migrateScope(session: ReviewSession) {
    const run = session.run;
    if (
      run?.version === '0.3.0-diff-only' &&
      run.fingerprint === this.previousFingerprint(session, run.version)
    ) {
      // A fingerprint migration keeps the interrupted model request and its exact thread.
      run.version = ANALYZER_VERSION;
      run.fingerprint = this.fingerprint(session);
      this.store.saveSession(session);
      return;
    }
    if (!run || !this.legacyScope(session)) return;
    const oldHome = run.checkpoint?.pending?.home ?? run.conversation?.home;
    // The old turn requested out-of-scope work. Do not resume that broad request.
    if (oldHome) run.conversation = { home: oldHome };
    if (run.checkpoint) delete run.checkpoint.pending;
    run.version = ANALYZER_VERSION;
    run.fingerprint = this.fingerprint(session);
    const scope = reviewScopeSnapshots(session, run);
    if (
      run.checkpoint?.stage === 'tests' &&
      missingSqlMethods(scope, run.result.indexes, run.result.database).length
    )
      run.checkpoint.stage = 'sql';
    this.event(
      session,
      run,
      t(
        'The scope is narrowed to the diff. The old broad request is cancelled; finished results are saved. Continuing requests only the missing changes.',
      ),
    );
    this.event(
      session,
      run,
      t(
        'Current scope: {0} changed test methods, {1} left. The analysis stays stopped.',
        reviewTestMethods(scope, run.result.indexes).length,
        missingTestMethods(scope, run.result.indexes, run.result.tests ?? []).length,
      ),
    );
  }
  fingerprint(session: ReviewSession, version = ANALYZER_VERSION, providerId = this.provider.id) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          version,
          providerId,
          process.env.REVIEW_CODEX_MODEL ?? 'default',
          session.snapshots.map((s) => [s.repoId, sourceIdentity(s), sourceIdentity(s, 'base')]),
          session.workflow?.technicalDelta?.snapshotIds.join() ===
          session.snapshots.map((s) => s.id).join()
            ? session.workflow.technicalDelta.changes
            : session.run?.sourceChanges,
          ...(session.update
            ? [
                [
                  session.update.previousReviewId,
                  session.update.scopeChanged,
                  session.update.changes.map((c) => [c.repoId, c.files]),
                ],
              ]
            : []),
        ]),
      )
      .digest('hex');
  }
  restoreCached(session: ReviewSession) {
    if (session.run && session.run.state !== 'running') this.migrateScope(session);
    if (session.run && this.markIncompleteCatalog(session.run, reviewScopeSnapshots(session)))
      this.store.saveSession(session);
    if (
      session.run &&
      !session.run.cacheRestored &&
      session.run.events[0]?.message ===
        t('A verified analysis of unchanged commits was restored from the cache.')
    ) {
      session.run.cacheRestored = true;
      this.store.saveSession(session);
    }
    if (!session.run && !session.update && this.store.analysisResult(this.fingerprint(session)))
      this.start(session);
  }
  private markIncompleteCatalog(run: AnalysisRun, snapshots: ReviewSession['snapshots']) {
    if (run.state !== 'complete' || this.skipped(run, 'scenarios')) return false;
    const missing = missingScenarios(
      scenarioRoots(snapshots, run.result.indexes),
      run.result.scenarios,
    );
    if (!missing.length) return false;
    run.state = 'partial';
    run.scenariosBaseState = 'complete';
    run.result.gaps = [
      ...new Set([
        ...run.result.gaps,
        t('Entry scenarios not analyzed: {0}', missing.map((root) => root.name).join(', ')),
      ]),
    ];
    return true;
  }
  /** One job per session; its live session object is shared with other writers until it ends. */
  private launch(session: ReviewSession, work: (controller: AbortController) => Promise<void>) {
    const controller = new AbortController();
    this.jobs.set(session.id, controller);
    this.activeSessions.set(session.id, session);
    this.measurements.start(session, this.provider.id);
    const execution = work(controller).finally(() => {
      this.measurements.finish(session);
      this.jobs.delete(session.id);
      this.activeSessions.delete(session.id);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
  }
  /** Adds one kind of artifact to a saved review in a new run; the saved review stays unchanged. */
  private supplement(
    session: ReviewSession,
    stage: 'scenarios' | 'tests' | 'sql',
    work: {
      intro?: string;
      refingerprint?: boolean;
      error?: string;
      done: string;
      complete: (run: AnalysisRun, signal: AbortSignal) => Promise<boolean>;
      /** For a request about one method: whether the whole stage is done now. */
      stageDone?: (run: AnalysisRun) => boolean;
    },
  ): AnalysisRun {
    const previous = session.run!;
    const baseState = `${stage}BaseState` as const;
    const wasComplete = (previous[baseState] ?? previous.state) === 'complete';
    const run: AnalysisRun = {
      ...structuredClone(previous),
      id: randomUUID(),
      ...(work.refingerprint ? { fingerprint: this.fingerprint(session) } : {}),
      state: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      checkpoint: { ...previous.checkpoint, stage },
    };
    run.result.gaps = withoutRunFailures(run.result.gaps);
    delete run.error;
    delete run.finishedAt;
    delete run.cacheRestored;
    delete run.scenariosBaseState;
    delete run.testsBaseState;
    delete run.sqlBaseState;
    run[baseState] = wasComplete ? 'complete' : 'partial';
    session.run = run;
    this.store.saveSession(session);
    const emit = (message: string) => this.event(session, run, message);
    this.launch(session, async (controller) => {
      try {
        if (work.intro) emit(work.intro);
        const complete = await work.complete(run, controller.signal);
        // Running a skipped stage by hand completes it for this review.
        if (work.stageDone ? work.stageDone(run) : complete)
          run.skippedSteps = run.skippedSteps?.filter((step) => step !== stage);
        run.state = wasComplete && complete ? 'complete' : 'partial';
        // Only full results are cached: a skipped stage must run when settings change.
        if (run.state === 'complete' && !run.skippedSteps?.length)
          this.store.saveAnalysisResult(run.fingerprint, run.result, session.snapshots);
      } catch (error) {
        if (run.checkpoint?.pending) delete run.checkpoint.pending.result;
        run.state = controller.signal.aborted ? 'cancelled' : 'partial';
        if (!controller.signal.aborted) {
          run.error = errorMessage(error);
          if (work.error) emit(`${work.error}: ${run.error}`);
        }
      } finally {
        run.finishedAt = new Date().toISOString();
        emit(`${work.done}: ${run.state}.`);
      }
    });
    return run;
  }
  /** Completes the missing scenarios, or, with a root id, builds the diagram of that entry only. */
  startScenarios(session: ReviewSession, rootId?: string): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError(t('The analysis is already running.'), 409);
    this.migrateScope(session);
    if (session.run?.checkpoint?.pending && session.run.checkpoint.stage !== 'scenarios')
      throw new AppError(t('There is an interrupted request. Press “Continue analysis”.'), 409);
    if (!session.run?.result.indexes.length) return this.start(session);
    const roots = scenarioRoots(reviewScopeSnapshots(session), session.run.result.indexes);
    const only = rootId === undefined ? undefined : roots.filter((root) => root.id === rootId);
    if (only && !only.length)
      throw new AppError(t('This entry method is not among the changed scenarios.'), 422);
    if (!missingScenarios(only ?? roots, session.run.result.scenarios).length) return session.run;
    return this.supplement(session, 'scenarios', {
      intro: only
        ? t('Building the diagram of {0}. The current review and comments are kept.', only[0].name)
        : t('Completing the scenario catalog. The current review and comments are kept.'),
      done: t('Scenario completion finished'),
      complete: (run, signal) => this.completeScenarios(session, run, signal, only),
      ...(only && {
        stageDone: (run: AnalysisRun) =>
          !missingScenarios(
            scenarioRoots(reviewScopeSnapshots(session, run), run.result.indexes),
            run.result.scenarios,
          ).length,
      }),
    });
  }
  private async completeScenarios(
    session: ReviewSession,
    run: AnalysisRun,
    signal: AbortSignal,
    only?: ScenarioRoot[],
  ): Promise<boolean> {
    const roots = scenarioRoots(reviewScopeSnapshots(session, run), run.result.indexes);
    const missing = missingScenarios(only ?? roots, run.result.scenarios);
    if (!missing.length) return true;
    this.event(
      session,
      run,
      t(
        'Entry scenarios not analyzed: {0}. Requesting only the catalog completion.',
        missing.length,
      ),
    );
    const response = await this.analyzeModel(
      session,
      run,
      {
        snapshots: reviewScopeSnapshots(session, run),
        indexes: run.result.indexes,
        scenariosOnly: missing,
      },
      signal,
      (message) => this.event(session, run, message),
    );
    signal.throwIfAborted();
    const checked = await validateModelResult(response, session.snapshots);
    for (const scenario of checked.scenarios) {
      if (missingScenarios(missing, [scenario]).length === missing.length) continue;
      if (run.result.scenarios.some((item) => item.id === scenario.id))
        scenario.id = `extra:${run.id}:${scenario.id}`;
      run.result.scenarios.push(scenario);
    }
    run.result.gaps = [
      ...new Set([
        ...run.result.gaps.filter((gap) => !gap.startsWith(t('Entry scenarios not analyzed:'))),
        ...checked.gaps,
      ]),
    ];
    const remaining = missingScenarios(roots, run.result.scenarios);
    // On request the other entries are not missing work, they are just not asked for yet.
    if (remaining.length && !only)
      run.result.gaps.push(
        t('Entry scenarios not analyzed: {0}', remaining.map((root) => root.name).join(', ')),
      );
    await this.commitModel(session, run);
    this.event(
      session,
      run,
      t(
        'Scenario catalog: {0}; uncovered entry methods: {1}.',
        run.result.scenarios.length,
        remaining.length,
      ),
    );
    return only ? !missingScenarios(only, run.result.scenarios).length : !remaining.length;
  }
  startTests(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError(t('The analysis is already running.'), 409);
    this.migrateScope(session);
    if (session.run?.checkpoint?.pending && session.run.checkpoint.stage !== 'tests')
      throw new AppError(t('There is an interrupted request. Press “Continue analysis”.'), 409);
    if (!session.run || (!session.run.result.summary && !session.run.result.scenarios.length))
      return this.start(session);
    if (
      session.run.result.testAnalysisVersion === TEST_ANALYSIS_VERSION &&
      session.run.state === 'complete' &&
      !missingTestMethods(
        reviewScopeSnapshots(session),
        session.run.result.indexes,
        session.run.result.tests ?? [],
      ).length
    )
      return session.run;
    return this.supplement(session, 'tests', {
      refingerprint: true,
      error: t('Test analysis error'),
      done: t('Test analysis finished'),
      complete: (run, signal) => this.completeTests(session, run, signal),
    });
  }
  private async completeTests(session: ReviewSession, run: AnalysisRun, signal: AbortSignal) {
    const emit = (message: string) => this.event(session, run, message);
    emit(t('Codex analyzes only changed test methods. Unchanged tests are not requested.'));
    for (const snapshot of session.snapshots)
      if (
        !run.result.indexes.some(
          (index) => index.repoId === snapshot.repoId && index.side === 'head',
        )
      )
        run.result.indexes.push((await storedIndex(this.store, snapshot, 'head', signal)).index);
    const targets = missingTestMethods(
      reviewScopeSnapshots(session, run),
      run.result.indexes,
      run.result.tests ?? [],
    );
    const pendingBatch = run.checkpoint?.pending?.testTargets;
    const outstanding = pendingBatch?.length
      ? targets.filter(
          (target) =>
            !pendingBatch.some((method) =>
              testMatchesMethod(
                {
                  method: method.name,
                  evidence: [method.evidence],
                } as import('../shared/model.js').ReviewTest,
                target,
              ),
            ),
        )
      : targets;
    // Steps are built locally, so a batch costs a title and a sentence per test.
    const batches = outstanding.length
      ? Array.from({ length: Math.ceil(outstanding.length / TEST_BATCH) }, (_, i) =>
          outstanding.slice(i * TEST_BATCH, (i + 1) * TEST_BATCH),
        )
      : [];
    if (pendingBatch?.length)
      batches.unshift(
        pendingBatch.filter((method) =>
          reviewTestMethods(reviewScopeSnapshots(session, run), run.result.indexes).some((target) =>
            testMatchesMethod(
              {
                method: method.name,
                evidence: [method.evidence],
              } as import('../shared/model.js').ReviewTest,
              target,
            ),
          ),
        ),
      );
    emit(
      t(
        'Changed test methods: {0}; left: {1}.',
        reviewTestMethods(reviewScopeSnapshots(session, run), run.result.indexes).length,
        targets.length,
      ),
    );
    for (const batch of batches.filter((batch) => batch.length)) {
      const model = await this.analyzeModel(
        session,
        run,
        {
          snapshots: reviewScopeSnapshots(session, run),
          indexes: run.result.indexes,
          testsOnly: true,
          testTargets: batch,
        },
        signal,
        emit,
      );
      signal.throwIfAborted();
      const checked = await validateModelResult(model, session.snapshots);
      if (
        !checked.tests?.length &&
        reviewTestMethods(reviewScopeSnapshots(session, run), run.result.indexes).length
      )
        throw new Error(
          t(
            'Codex did not return a verifiable test analysis. The saved review is unchanged; you can retry.',
          ),
        );
      run.result.tests ??= [];
      const previous = session.history?.find((r) => r.id === run.previousReviewId);
      if (previous)
        checked.tests = stableArtifactIds(
          checked.tests ?? [],
          previous.run.result.tests ?? [],
          run.result.indexes,
          previous.run.result.indexes,
        );
      for (const test of checked.tests ?? []) {
        if (batch.length && !batch.some((method) => testMatchesMethod(test, method))) continue;
        if (run.result.tests.some((existing) => JSON.stringify(existing) === JSON.stringify(test)))
          continue;
        if (run.result.tests.some((existing) => existing.id === test.id))
          test.id = `extra:${run.id}:${run.result.tests.length}:${test.id}`;
        run.result.tests.push(test);
      }
      run.result.pendingDescriptions = run.result.pendingDescriptions?.filter(
        (p) => p.section !== 'tests' || !run.result.tests!.some((test) => test.id === p.id),
      );
      run.result.gaps = [...new Set([...run.result.gaps, ...checked.gaps])];
      await this.commitModel(session, run);
      emit(
        t(
          'Tests saved: {0}; left to analyze: {1}.',
          run.result.tests.length,
          missingTestMethods(
            reviewScopeSnapshots(session, run),
            run.result.indexes,
            run.result.tests,
          ).length,
        ),
      );
    }
    const missing = missingTestMethods(
      reviewScopeSnapshots(session, run),
      run.result.indexes,
      run.result.tests ?? [],
    );
    if (missing.length) delete run.result.testAnalysisVersion;
    else run.result.testAnalysisVersion = TEST_ANALYSIS_VERSION;
    return !missing.length;
  }
  /** Completes the missing SQL, or, with a line of a query method, the SQL of that method only. */
  startSql(session: ReviewSession, at?: SqlMethodRef): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError(t('The analysis is already running.'), 409);
    this.migrateScope(session);
    if (session.run?.checkpoint?.pending && session.run.checkpoint.stage !== 'sql')
      throw new AppError(t('There is an interrupted request. Press “Continue analysis”.'), 409);
    if (!session.run || (!session.run.result.summary && !session.run.result.scenarios.length))
      return this.start(session);
    if (at) {
      const result = session.run.result;
      const method = sqlMethods(reviewScopeSnapshots(session), result.indexes).find(
        (item) =>
          item.evidence.repoId === at.repoId &&
          item.evidence.side === at.side &&
          item.evidence.path === at.path &&
          item.evidence.startLine <= at.line &&
          item.evidence.endLine >= at.line,
      );
      if (!method)
        throw new AppError(t('This method has no changed database queries to analyze.'), 422);
      if (result.database.some((item) => queryMatchesMethod(item, method))) return session.run;
      return this.supplement(session, 'sql', {
        refingerprint: true,
        intro: t('Codex is generating SQL for {0}.', method.name),
        error: t('SQL completion error'),
        done: t('SQL completion finished'),
        complete: (run, signal) => this.completeSql(session, run, signal, [method]),
        stageDone: (run) =>
          !missingSqlMethods(
            reviewScopeSnapshots(session, run),
            run.result.indexes,
            run.result.database,
          ).length,
      });
    }
    if (
      session.run.result.sqlAnalysisVersion === SQL_ANALYSIS_VERSION &&
      session.run.state === 'complete' &&
      !missingSqlMethods(
        reviewScopeSnapshots(session),
        session.run.result.indexes,
        session.run.result.database,
      ).length
    )
      return session.run;
    return this.supplement(session, 'sql', {
      refingerprint: true,
      error: t('SQL completion error'),
      done: t('SQL completion finished'),
      complete: async (run, signal) => {
        const missing = (await this.completeSql(session, run, signal))
          ? []
          : missingSqlMethods(
              reviewScopeSnapshots(session, run),
              run.result.indexes,
              run.result.database,
            );
        if (run.checkpoint) run.checkpoint.stage = missing.length ? 'sql' : 'done';
        return !missing.length;
      },
    });
  }
  private async completeSql(
    session: ReviewSession,
    run: AnalysisRun,
    signal: AbortSignal,
    only?: IndexedMethod[],
  ) {
    const emit = (message: string) => this.event(session, run, message);
    if (
      !only &&
      !run.checkpoint?.pending &&
      !missingSqlMethods(
        reviewScopeSnapshots(session, run),
        run.result.indexes,
        run.result.database,
      ).length
    ) {
      run.result.sqlAnalysisVersion = SQL_ANALYSIS_VERSION;
      emit(t('No changed database queries need further analysis.'));
      return true;
    }
    emit(t('Codex is completing SQL. The saved PR review stays the same.'));
    const model = await this.analyzeModel(
      session,
      run,
      {
        snapshots: reviewScopeSnapshots(session, run),
        indexes: run.result.indexes,
        sqlOnly: true,
        sqlTargets:
          only ??
          run.checkpoint?.pending?.sqlTargets ??
          missingSqlMethods(
            reviewScopeSnapshots(session, run),
            run.result.indexes,
            run.result.database,
          ),
      },
      signal,
      emit,
    );
    signal.throwIfAborted();
    const checked = await validateModelResult(model, session.snapshots);
    const allowedQueries = sqlMethods(reviewScopeSnapshots(session, run), run.result.indexes);
    checked.database = checked.database.filter((item) =>
      allowedQueries.some((method) => queryMatchesMethod(item, method)),
    );
    if (
      !checked.database.some((item) => item.query) &&
      missingSqlMethods(reviewScopeSnapshots(session, run), run.result.indexes, run.result.database)
        .length
    )
      throw new Error(t('Codex did not return SQL for the requested methods. Results are saved.'));
    const key = (item: DatabaseOperation) =>
      item.query
        ? JSON.stringify([
            item.query.evidence.repoId,
            item.query.evidence.side,
            item.query.evidence.path,
            queryMethodName(item.query.method),
            item.query.evidence.startLine,
          ])
        : item.id;
    const previous = session.history?.find((r) => r.id === run.previousReviewId);
    if (previous)
      checked.database = stableArtifactIds(
        checked.database,
        previous.run.result.database,
        run.result.indexes,
        previous.run.result.indexes,
      );
    const updated = new Set(checked.database.map(key));
    run.result.database = [
      ...run.result.database.filter((item) => !updated.has(key(item))),
      ...checked.database,
    ];
    run.result.pendingDescriptions = run.result.pendingDescriptions?.filter(
      (p) => p.section !== 'database' || !run.result.database.some((item) => item.id === p.id),
    );
    run.result.gaps = [...new Set([...run.result.gaps, ...checked.gaps])];
    const missing = missingSqlMethods(
      reviewScopeSnapshots(session, run),
      run.result.indexes,
      run.result.database,
    );
    if (missing.length) delete run.result.sqlAnalysisVersion;
    else run.result.sqlAnalysisVersion = SQL_ANALYSIS_VERSION;
    await this.commitModel(session, run);
    if (only) {
      const done = only.every((method) =>
        run.result.database.some((item) => queryMatchesMethod(item, method)),
      );
      emit(done ? t('SQL is ready.') : t('Codex did not return SQL for this method.'));
      return done;
    }
    emit(
      t(
        'SQL: methods not analyzed {0}{1}.',
        missing.length,
        missing.length ? ` (${missing.map((m) => m.name).join(', ')})` : '',
      ),
    );
    return !missing.length;
  }
  start(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError(t('The analysis is already running.'), 409);
    this.migrateScope(session);
    if (
      session.run &&
      session.run.state !== 'running' &&
      session.run.state !== 'complete' &&
      (session.run.fingerprint === this.fingerprint(session) || this.legacyScope(session))
    )
      return this.resume(session);
    if (
      session.run?.result.summary &&
      !this.disabled('scenarios') &&
      missingScenarios(
        scenarioRoots(reviewScopeSnapshots(session), session.run.result.indexes),
        session.run.result.scenarios,
      ).length
    )
      return this.startScenarios(session);
    let fingerprint = this.fingerprint(session);
    if (session.run?.fingerprint === fingerprint && session.run.state === 'complete')
      return session.run;
    archiveReview(
      session,
      this.store
        .drafts(session.id)
        .filter((draft) => session.snapshots.some((snapshot) => snapshot.id === draft.snapshotId)),
    );
    const previous = session.history?.at(-1);
    if (previous && session.update?.previousReviewId !== previous.id) {
      session.update = {
        id: randomUUID(),
        at: new Date().toISOString(),
        previousReviewId: previous.id,
        changes: session.snapshots.map((s) => ({
          repoId: s.repoId,
          fromSha: s.headSha,
          toSha: s.headSha,
          files: [],
        })),
        discussion: [],
        gaps: [],
      };
      fingerprint = this.fingerprint(session);
    }
    const run: AnalysisRun = {
      id: randomUUID(),
      sessionId: session.id,
      version: ANALYZER_VERSION,
      fingerprint,
      state: 'running',
      startedAt: new Date().toISOString(),
      result: { ...emptyModelResult(), contracts: [], indexes: [] },
      ...(session.workflow?.technicalDelta?.snapshotIds.join() ===
      session.snapshots.map((s) => s.id).join()
        ? { sourceChanges: session.workflow.technicalDelta.changes }
        : {}),
      events: [],
      ...(previous && !session.update?.scopeChanged ? { previousReviewId: previous.id } : {}),
    };
    const cached = this.store.analysisResult(fingerprint);
    if (cached) {
      run.cacheRestored = true;
      run.result = cached;
      run.state = 'complete';
      run.finishedAt = new Date().toISOString();
      run.events = [
        {
          seq: 1,
          at: run.finishedAt,
          message: t('A verified analysis of unchanged commits was restored from the cache.'),
        },
      ];
      this.markIncompleteCatalog(run, session.snapshots);
    }
    session.run = run;
    this.store.saveSession(session);
    if (cached) return run;
    this.launch(session, (controller) => this.execute(session, run, controller));
    return run;
  }
  cancel(id: string) {
    const controller = this.jobs.get(id);
    if (!controller) throw new AppError(t('No analysis is running.'), 409);
    controller.abort();
  }
  resume(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id) || session.run?.state === 'running')
      throw new AppError(t('The analysis is already in progress.'), 409);
    const run = session.run;
    if (!run) throw new AppError(t('There is no saved analysis to continue.'), 409);
    this.migrateScope(session);
    if (run.fingerprint !== this.fingerprint(session))
      throw new AppError(
        t(
          'The code version or analysis settings changed. Continuation applies only to the saved version.',
        ),
        409,
      );
    if (run.state === 'complete') return run;
    const missingRoots = () =>
      missingScenarios(
        scenarioRoots(reviewScopeSnapshots(session, run), run.result.indexes),
        run.result.scenarios,
      ).length;
    const missingTests = () =>
      missingTestMethods(
        reviewScopeSnapshots(session, run),
        run.result.indexes,
        run.result.tests ?? [],
      ).length;
    const missingSql = () =>
      missingSqlMethods(reviewScopeSnapshots(session, run), run.result.indexes, run.result.database)
        .length;
    if (!run.checkpoint) {
      // Compatibility with saved analyses created before persistent model threads.
      const reviewed = !!run.result.summary || !!run.result.scenarios.length;
      run.checkpoint = {
        stage: !reviewed
          ? 'prepare'
          : missingRoots()
            ? 'scenarios'
            : missingSql()
              ? 'sql'
              : missingTests()
                ? 'tests'
                : 'done',
      };
    }
    if (run.checkpoint.stage === 'done') {
      run.checkpoint.stage =
        missingRoots() && !this.skipped(run, 'scenarios')
          ? 'scenarios'
          : missingSql() && !this.skipped(run, 'sql')
            ? 'sql'
            : missingTests() && !this.skipped(run, 'tests')
              ? 'tests'
              : 'done';
    }
    if (run.checkpoint.stage === 'done') {
      if (!run.checkpoint.coreIncomplete) {
        run.state = 'complete';
        delete run.error;
        if (!run.skippedSteps?.length)
          this.store.saveAnalysisResult(run.fingerprint, run.result, session.snapshots);
        this.event(session, run, t('All stages are already saved. No new analysis is needed.'));
      }
      return run;
    }
    run.state = 'running';
    delete run.error;
    delete run.finishedAt;
    run.result.gaps = withoutRunFailures(run.result.gaps);
    const message = t(
      'Continuing the analysis from the “{0}” stage. Finished results are saved.',
      {
        prepare: t('preparation'),
        review: t('main review'),
        scenarios: t('scenarios'),
        tests: tc('stage', 'tests'),
        sql: 'SQL',
      }[run.checkpoint.stage],
    );
    this.launch(session, (controller) => {
      this.event(session, run, message);
      return this.execute(session, run, controller);
    });
    return run;
  }
  addMessage(session: ReviewSession, text: string) {
    session = this.activeSessions.get(session.id) ?? session;
    const run = session.run;
    if (!run) throw new AppError(t('Start the analysis first.'), 409);
    const message = { id: randomUUID(), at: new Date().toISOString(), text };
    (run.messages ??= []).push(message);
    this.store.saveSession(session);
    if (this.jobs.has(session.id)) {
      this.event(
        session,
        run,
        t(
          'Note received. Pausing the current stage; press “Continue” to include it in the same conversation.',
        ),
      );
      this.jobs.get(session.id)!.abort();
    }
    return message;
  }
  isRunning(id: string) {
    return this.jobs.has(id);
  }
  /** A running analysis saves its own session object on every event; others must change that object. */
  session(id: string) {
    return this.activeSessions.get(id) ?? this.store.session(id);
  }
  async stopAll() {
    for (const c of this.jobs.values()) c.abort();
    await Promise.allSettled(this.executions);
  }
  subscribe(id: string, callback: (event: ProgressEvent) => void) {
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id)!.add(callback);
    return () => {
      this.subscribers.get(id)?.delete(callback);
    };
  }
  private event(
    session: ReviewSession,
    run: AnalysisRun,
    message: string,
    kind: ProgressEvent['kind'] = 'progress',
  ) {
    this.measurements.stage(session.id, run.checkpoint?.stage ?? 'prepare');
    const event = { seq: run.events.length + 1, at: new Date().toISOString(), message, kind };
    run.events.push(event);
    this.store.saveSession(session);
    for (const listener of this.subscribers.get(session.id) ?? []) listener(event);
  }
  private async execute(session: ReviewSession, run: AnalysisRun, controller: AbortController) {
    const signal = controller.signal;
    run.checkpoint ??= { stage: 'prepare' };
    let incomplete = run.checkpoint.coreIncomplete ?? false;
    const emit = (m: string) => this.event(session, run, m);
    /** A stage switched off in the settings is skipped and remembered on the run. */
    const skip = (step: OptionalStep) => {
      if (!this.disabled(step)) return false;
      if (!this.skipped(run, step)) (run.skippedSteps ??= []).push(step);
      const title = t(optionalSteps.find((item) => item.id === step)!.title);
      emit(
        (this.store.onDemandSteps() as OptionalStep[]).includes(step)
          ? t('The “{0}” stage runs on request for a method and was skipped.', title)
          : t('The “{0}” stage is turned off in the settings and was skipped.', title),
      );
      return true;
    };
    try {
      if (run.checkpoint.stage === 'prepare') {
        emit(t('Indexing the pinned Git snapshots…'));
        for (const snapshot of session.snapshots) {
          signal.throwIfAborted();
          for (const side of ['base', 'head'] as const) {
            if (
              run.result.indexes.some(
                (index) => index.repoId === snapshot.repoId && index.side === side,
              )
            )
              continue;
            try {
              const { index, cached } = await storedIndex(this.store, snapshot, side, signal);
              if (cached)
                emit(
                  t('{0}/{1}: reused the index of an unchanged commit.', snapshot.repoName, side),
                );
              run.result.indexes.push(index);
              if (index.errors.length) run.result.gaps.push(...index.errors);
            } catch (e) {
              signal.throwIfAborted();
              incomplete = true;
              run.result.gaps.push(t('Index {0}/{1}: {2}', snapshot.repoName, side, String(e)));
            }
          }
          try {
            for (const contract of await extractContracts(snapshot))
              if (!run.result.contracts.some((item) => item.id === contract.id))
                run.result.contracts.push(contract);
          } catch (e) {
            incomplete = true;
            run.result.gaps.push(t('Contracts {0}: {1}', snapshot.repoName, String(e)));
          }
          for (const f of snapshot.files.filter((f) => /\.sql$/i.test(f.path))) {
            const side = snapshot.headFiles.includes(f.path) ? 'head' : 'base';
            const path = side === 'head' ? f.path : (f.oldPath ?? f.path);
            if (!(side === 'head' ? snapshot.headFiles : snapshot.baseFiles).includes(path))
              continue;
            let sql: string;
            try {
              sql = await readSource(snapshot, { side, path });
            } catch (e) {
              incomplete = true;
              run.result.gaps.push(`SQL ${snapshot.repoName}/${path}: ${String(e)}`);
              continue;
            }
            const op: DatabaseOperation = {
              id: `sql:${snapshot.repoId}:${f.path}`,
              title: f.path,
              summary: side === 'head' ? t('SQL file in the new version') : t('SQL file removed'),
              confidence: 'extracted',
              kind: /migration|liquibase|flyway|db\/changelog/i.test(path) ? 'migration' : 'sql',
              sql,
              dialect: tc('dialect', 'Unknown'),
              tables: [
                ...new Set(
                  Array.from(
                    sql.matchAll(/\b(?:TABLE|INTO|UPDATE|FROM|JOIN)\s+([\w."`]+)/gi),
                    (m) => m[1],
                  ),
                ),
              ],
              unknowns: [t('Execution and query plan were not checked')],
              evidence: [
                {
                  repoId: snapshot.repoId,
                  side,
                  path,
                  startLine: 1,
                  endLine: sql.split('\n').length,
                },
              ],
            };
            if (!run.result.database.some((item) => item.id === op.id))
              run.result.database.push(op);
          }
          emit(t('{0}: index and contracts ready.', snapshot.repoName));
        }
        try {
          await attachBuilds(session.snapshots, run.result.contracts);
        } catch (e) {
          run.result.gaps.push(t('Contract build: {0}', String(e)));
        }
        emit(
          t(
            'Scope: {0} files changed; affected scenarios {1}, database queries {2}, tests {3}. Unchanged parts of the project are context only.',
            session.snapshots.reduce((n, snapshot) => n + snapshot.files.length, 0),
            scenarioRoots(reviewScopeSnapshots(session, run), run.result.indexes).length,
            missingSqlMethods(reviewScopeSnapshots(session, run), run.result.indexes, []).length,
            reviewTestMethods(reviewScopeSnapshots(session, run), run.result.indexes).length,
          ),
        );
        run.checkpoint.coreIncomplete = incomplete;
        run.checkpoint.stage = 'review';
        emit(t('Preparation saved. Starting the main review.'));
      }
      if (run.checkpoint.stage === 'review') {
        if (!run.result.changes && this.provider.describeChanges && !skip('changes')) {
          const describe = this.provider.describeChanges.bind(this.provider);
          try {
            run.result.changes = await changeCards(
              changeUnits(reviewScopeSnapshots(session, run), run.result.indexes),
              {
                get: (key) => this.store.changeCard(key),
                set: (key, card) => this.store.saveChangeCard(key, card),
              },
              async (units) => {
                const metric = this.measurements.request(session.id, 'changes', units.length);
                let previous: TokenTotals | undefined;
                try {
                  const result = await describe(units, signal, (event) => {
                    if (event.type !== 'turn.completed') return;
                    const total = {
                      input: event.usage.input_tokens,
                      cached: event.usage.cached_input_tokens,
                      output: event.usage.output_tokens,
                    };
                    const spent = tokensSince(previous, total);
                    previous = total;
                    this.measurements.usage(session.id, metric, spent);
                    const usage = (run.usage ??= { input: 0, cached: 0, output: 0 });
                    usage.input += spent.input;
                    usage.cached += spent.cached;
                    usage.output += spent.output;
                    this.event(
                      session,
                      run,
                      t(
                        'Description tokens: input {0}, cached {1}, output {2}.',
                        spent.input,
                        spent.cached,
                        spent.output,
                      ),
                      'usage',
                    );
                  });
                  this.measurements.finishRequest(session.id, metric);
                  return result;
                } catch (error) {
                  this.measurements.finishRequest(session.id, metric, error, signal.aborted);
                  throw error;
                }
              },
              emit,
            );
          } catch (e) {
            signal.throwIfAborted();
            run.result.changes = [];
            run.result.gaps.push(t('Change descriptions: {0}', String(e)));
          }
          this.store.saveSession(session);
          emit(t('Changes described: {0}.', run.result.changes.length));
        }
        const deterministic = run.result.database;
        const previous = session.history?.find((revision) => revision.id === run.previousReviewId);
        const affected = previous ? await affectedPrevious(previous, session.snapshots) : undefined;
        const model = await this.analyzeModel(
          session,
          run,
          {
            snapshots: reviewScopeSnapshots(session, run),
            indexes: run.result.indexes,
            changeCards: run.result.changes,
            ...(previous
              ? {
                  followUp: {
                    previousReviewId: previous.id,
                    previous: { ...affected!, tests: [], database: [] },
                    comments: previous.drafts.flatMap((draft) =>
                      draft.comments
                        .filter(
                          (comment) =>
                            !comment.evidence ||
                            session.update?.changes.some(
                              (change) =>
                                change.repoId === comment.evidence!.repoId &&
                                change.files.some(
                                  (file) =>
                                    file.path === comment.evidence!.path ||
                                    file.oldPath === comment.evidence!.path,
                                ),
                            ),
                        )
                        .map((comment) => ({
                          ...comment,
                          repoId: previous.snapshots.find((s) => s.id === draft.snapshotId)?.repoId,
                        })),
                    ),
                    reviewBodies: previous.drafts
                      .filter((draft) => draft.body.trim())
                      .map((draft) => draft.body),
                    changes:
                      session.update?.previousReviewId === previous.id
                        ? session.update.changes
                        : [],
                    discussion: session.update?.discussion ?? [],
                    discussionContext: (session.discussion ?? []).filter((comment) =>
                      session.update?.discussion.some(
                        (reply) => reply.repoId === comment.repoId && reply.replyTo === comment.id,
                      ),
                    ),
                    gaps: session.update?.gaps ?? [],
                  },
                }
              : {}),
          },
          signal,
          emit,
        );
        signal.throwIfAborted();
        emit(t('Checking model references and line ranges…'));
        const checked = await validateModelResult(model, session.snapshots);
        if (previous) {
          checked.followUp ??= {
            summary: t(
              'Additional results received. Items without a separate answer keep an unknown status.',
            ),
            items: [],
          };
          const ids = new Set([
            ...previous.run.result.findings.map((finding) => finding.id),
            ...previous.drafts.flatMap((draft) => draft.comments.map((comment) => comment.id)),
          ]);
          checked.followUp.items = checked.followUp.items.filter((item) =>
            ids.has(item.previousId),
          );
          const reported = new Set(checked.followUp.items.map((item) => item.previousId));
          for (const id of ids)
            if (!reported.has(id))
              checked.followUp.items.push({
                previousId: id,
                status:
                  affected?.findings.some((f) => f.id === id) ||
                  previous.drafts.some((d) =>
                    d.comments.some(
                      (c) =>
                        c.id === id &&
                        (!c.evidence ||
                          session.update?.changes.some(
                            (change) =>
                              change.repoId === c.evidence!.repoId &&
                              change.files.some((f) => f.path === c.evidence!.path),
                          )),
                    ),
                  )
                    ? 'unknown'
                    : 'still_present',
                summary: t(
                  'No result was received for this remark or question. It needs checking.',
                ),
                evidence: [],
              });
        } else delete checked.followUp;
        const merged = previous
          ? await mergeIncremental(previous, session.snapshots, checked, run.result.indexes)
          : checked;
        Object.assign(run.result, {
          ...merged,
          database: [
            ...deterministic,
            ...merged.database.filter((item) => !deterministic.some((op) => op.id === item.id)),
          ],
          gaps: [...run.result.gaps, ...merged.gaps],
        });
        if (
          missingSqlMethods(
            reviewScopeSnapshots(session, run),
            run.result.indexes,
            run.result.database,
          ).length
        )
          delete run.result.sqlAnalysisVersion;
        else run.result.sqlAnalysisVersion = SQL_ANALYSIS_VERSION;
        if (
          model.tests &&
          !missingTestMethods(
            reviewScopeSnapshots(session, run),
            run.result.indexes,
            run.result.tests ?? [],
          ).length
        )
          run.result.testAnalysisVersion = TEST_ANALYSIS_VERSION;
        else delete run.result.testAnalysisVersion;
        run.checkpoint.stage = 'scenarios';
        await this.commitModel(session, run);
        emit(t('Main review saved.'));
      }
      if (run.checkpoint.stage === 'scenarios' && !skip('scenarios')) {
        run.scenariosBaseState = incomplete ? 'partial' : 'complete';
        if (!(await this.completeScenarios(session, run, signal))) incomplete = true;
        else delete run.scenariosBaseState;
        run.checkpoint.stage = 'sql';
        emit(t('Scenario stage saved.'));
      }
      if (run.checkpoint.stage === 'scenarios') run.checkpoint.stage = 'sql';
      if (run.checkpoint.stage === 'sql' && !skip('sql')) {
        emit(t('Analyzing database changes after the diagrams.'));
        if (!(await this.completeSql(session, run, signal))) incomplete = true;
        run.checkpoint.stage = 'tests';
        emit(t('Database stage saved.'));
      }
      if (run.checkpoint.stage === 'sql') run.checkpoint.stage = 'tests';
      if (run.checkpoint.stage === 'tests' && !skip('tests')) {
        if (
          missingTestMethods(
            reviewScopeSnapshots(session, run),
            run.result.indexes,
            run.result.tests ?? [],
          ).length
        ) {
          run.testsBaseState = incomplete ? 'partial' : 'complete';
          if (!(await this.completeTests(session, run, signal))) incomplete = true;
        }
      }
      if (run.checkpoint.stage === 'tests') run.checkpoint.stage = 'done';
      const scope = reviewScopeSnapshots(session, run);
      incomplete ||=
        (!this.skipped(run, 'scenarios') &&
          missingScenarios(scenarioRoots(scope, run.result.indexes), run.result.scenarios).length >
            0) ||
        (!this.skipped(run, 'tests') &&
          missingTestMethods(scope, run.result.indexes, run.result.tests ?? []).length > 0) ||
        (!this.skipped(run, 'sql') &&
          missingSqlMethods(scope, run.result.indexes, run.result.database).length > 0);
      run.state = incomplete ? 'partial' : 'complete';
      // Only full results are cached: a skipped stage must run when settings change.
      if (run.state === 'complete' && !run.skippedSteps?.length)
        this.store.saveAnalysisResult(run.fingerprint, run.result, session.snapshots);
    } catch (e) {
      if (run.checkpoint?.pending) delete run.checkpoint.pending.result;
      if (signal.aborted) {
        run.state = 'cancelled';
        run.result.gaps.push(t('Analysis cancelled by the user.'));
      } else {
        run.state = 'partial';
        run.error = errorMessage(e);
        run.result.gaps.push(t('Codex/analysis: {0}', run.error));
        emit(t('Analysis error: {0}', run.error));
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      emit(t('Analysis finished: {0}.', run.state));
    }
  }
}
