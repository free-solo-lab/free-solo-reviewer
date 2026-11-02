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
} from '../shared/model.js';
import { indexSnapshot, INDEX_VERSION } from './indexer.js';
import { extractContracts } from './contracts.js';
import { readSource } from './repository.js';
import { validateModelResult } from './validation.js';
import type { AnalysisProvider } from './provider.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { archiveReview } from './revisions.js';
import { mergeIncremental } from './incremental.js';
import { scenarioRoots, missingScenarios } from '../shared/scenario-coverage.js';
import { missingSqlMethods } from '../shared/sql-coverage.js';
import {
  isTestPath,
  missingTestMethods,
  reviewTestMethods,
  testMatchesMethod,
} from '../shared/test-coverage.js';
export class AnalysisManager {
  private jobs = new Map<string, AbortController>();
  private executions = new Set<Promise<void>>();
  private subscribers = new Map<string, Set<(event: ProgressEvent) => void>>();
  constructor(
    private store: Store,
    private provider: AnalysisProvider,
  ) {}
  fingerprint(session: ReviewSession) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          ANALYZER_VERSION,
          this.provider.id,
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
  restoreCached(session: ReviewSession) {
    if (session.run && this.markIncompleteCatalog(session.run, session.snapshots))
      this.store.saveSession(session);
    if (
      session.run &&
      !session.run.cacheRestored &&
      session.run.events[0]?.message ===
        'Восстановлен проверенный анализ неизменённых коммитов из кэша.'
    ) {
      session.run.cacheRestored = true;
      this.store.saveSession(session);
    }
    if (!session.run && !session.update && this.store.analysisResult(this.fingerprint(session)))
      this.start(session);
  }
  private markIncompleteCatalog(run: AnalysisRun, snapshots: ReviewSession['snapshots']) {
    if (run.state !== 'complete') return false;
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
        `Не разобраны входные сценарии: ${missing.map((root) => root.name).join(', ')}`,
      ]),
    ];
    return true;
  }
  startScenarios(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError('Анализ уже запущен.', 409);
    if (!session.run?.result.indexes.length) return this.start(session);
    const roots = scenarioRoots(session.snapshots, session.run.result.indexes);
    if (!missingScenarios(roots, session.run.result.scenarios).length) return session.run;
    const wasComplete = (session.run.scenariosBaseState ?? session.run.state) === 'complete';
    const run: AnalysisRun = {
      ...structuredClone(session.run),
      id: randomUUID(),
      state: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      scenariosBaseState: wasComplete ? 'complete' : 'partial',
    };
    delete run.error;
    delete run.finishedAt;
    delete run.cacheRestored;
    delete run.testsBaseState;
    delete run.sqlBaseState;
    session.run = run;
    this.store.saveSession(session);
    const controller = new AbortController();
    this.jobs.set(session.id, controller);
    const execution = (async () => {
      try {
        this.event(
          session,
          run,
          'Дополняем каталог сценариев. Текущий разбор и комментарии сохранены.',
        );
        const complete = await this.completeScenarios(session, run, controller.signal);
        run.state = complete && wasComplete ? 'complete' : 'partial';
        if (run.state === 'complete') this.store.saveAnalysisResult(run.fingerprint, run.result);
      } catch (error) {
        run.state = controller.signal.aborted ? 'cancelled' : 'partial';
        if (!controller.signal.aborted)
          run.error = error instanceof Error ? error.message : String(error);
      } finally {
        run.finishedAt = new Date().toISOString();
        this.event(session, run, `Дополнение сценариев завершено: ${run.state}.`);
      }
    })().finally(() => {
      this.jobs.delete(session.id);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
    return run;
  }
  private async completeScenarios(
    session: ReviewSession,
    run: AnalysisRun,
    signal: AbortSignal,
  ): Promise<boolean> {
    const roots = scenarioRoots(session.snapshots, run.result.indexes);
    const missing = missingScenarios(roots, run.result.scenarios);
    if (!missing.length) return true;
    this.event(
      session,
      run,
      `Не разобрано входных сценариев: ${missing.length}. Запрашиваем только дополнение каталога.`,
    );
    const response = await this.provider.analyze(
      { snapshots: session.snapshots, indexes: run.result.indexes, scenariosOnly: missing },
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
        ...run.result.gaps.filter((gap) => !gap.startsWith('Не разобраны входные сценарии:')),
        ...checked.gaps,
      ]),
    ];
    const remaining = missingScenarios(roots, run.result.scenarios);
    if (remaining.length)
      run.result.gaps.push(
        `Не разобраны входные сценарии: ${remaining.map((root) => root.name).join(', ')}`,
      );
    this.event(
      session,
      run,
      `Каталог сценариев: ${run.result.scenarios.length}; непокрытых входных методов: ${remaining.length}.`,
    );
    return !remaining.length;
  }
  startTests(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError('Анализ уже запущен.', 409);
    if (!session.run || (!session.run.result.summary && !session.run.result.scenarios.length))
      return this.start(session);
    if (
      session.run.result.testAnalysisVersion === TEST_ANALYSIS_VERSION &&
      session.run.state === 'complete' &&
      !missingTestMethods(
        session.snapshots,
        session.run.result.indexes,
        session.run.result.tests ?? [],
      ).length
    )
      return session.run;
    const wasComplete = (session.run.testsBaseState ?? session.run.state) === 'complete';
    const run: AnalysisRun = {
      ...structuredClone(session.run),
      id: randomUUID(),
      fingerprint: this.fingerprint(session),
      state: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      testsBaseState: wasComplete ? 'complete' : 'partial',
    };
    delete run.error;
    delete run.finishedAt;
    delete run.cacheRestored;
    delete run.sqlBaseState;
    delete run.scenariosBaseState;
    session.run = run;
    this.store.saveSession(session);
    const controller = new AbortController();
    this.jobs.set(session.id, controller);
    const execution = this.executeTests(session, run, controller, wasComplete).finally(() => {
      this.jobs.delete(session.id);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
    return run;
  }
  private async completeTests(session: ReviewSession, run: AnalysisRun, signal: AbortSignal) {
    const emit = (message: string) => this.event(session, run, message);
    emit('Codex дополняет тесты. Основное ревью сохранено.');
    const targets = missingTestMethods(
      session.snapshots,
      run.result.indexes,
      run.result.tests ?? [],
    );
    const batches = targets.length
      ? Array.from({ length: Math.ceil(targets.length / 10) }, (_, i) =>
          targets.slice(i * 10, (i + 1) * 10),
        )
      : [[]];
    for (const batch of batches) {
      const model = await this.provider.analyze(
        {
          snapshots: session.snapshots,
          indexes: run.result.indexes,
          testsOnly: true,
          testTargets: batch,
        },
        signal,
        emit,
      );
      signal.throwIfAborted();
      const checked = await validateModelResult(model, session.snapshots);
      if (!checked.tests?.length && reviewTestMethods(session.snapshots, run.result.indexes).length)
        throw new Error(
          'Codex не вернул проверяемый разбор тестов. Сохранённое ревью не изменено; дополнение можно повторить.',
        );
      run.result.tests ??= [];
      for (const test of checked.tests ?? []) {
        if (batch.length && !batch.some((method) => testMatchesMethod(test, method))) continue;
        if (run.result.tests.some((existing) => JSON.stringify(existing) === JSON.stringify(test)))
          continue;
        if (run.result.tests.some((existing) => existing.id === test.id))
          test.id = `extra:${run.id}:${run.result.tests.length}:${test.id}`;
        run.result.tests.push(test);
      }
      run.result.gaps = [...new Set([...run.result.gaps, ...checked.gaps])];
      emit(
        `Сохранено тестов: ${run.result.tests.length}; осталось разобрать: ${missingTestMethods(session.snapshots, run.result.indexes, run.result.tests).length}.`,
      );
    }
    const missing = missingTestMethods(
      session.snapshots,
      run.result.indexes,
      run.result.tests ?? [],
    );
    if (missing.length) delete run.result.testAnalysisVersion;
    else run.result.testAnalysisVersion = TEST_ANALYSIS_VERSION;
    return !missing.length;
  }
  private async executeTests(
    session: ReviewSession,
    run: AnalysisRun,
    controller: AbortController,
    wasComplete: boolean,
  ) {
    const emit = (message: string) => this.event(session, run, message);
    try {
      const complete = await this.completeTests(session, run, controller.signal);
      run.state = wasComplete && complete ? 'complete' : 'partial';
      if (run.state === 'complete') this.store.saveAnalysisResult(run.fingerprint, run.result);
    } catch (error) {
      run.state = controller.signal.aborted ? 'cancelled' : 'partial';
      if (!controller.signal.aborted) {
        run.error = error instanceof Error ? error.message : String(error);
        emit(`Ошибка разбора тестов: ${run.error}`);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      emit(`Разбор тестов завершён: ${run.state}.`);
    }
  }
  startSql(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError('Анализ уже запущен.', 409);
    if (!session.run || (!session.run.result.summary && !session.run.result.scenarios.length))
      return this.start(session);
    if (
      session.run.result.sqlAnalysisVersion === SQL_ANALYSIS_VERSION &&
      session.run.state === 'complete' &&
      !missingSqlMethods(session.snapshots, session.run.result.indexes, session.run.result.database)
        .length
    )
      return session.run;
    const wasComplete = (session.run.sqlBaseState ?? session.run.state) === 'complete';
    const run: AnalysisRun = {
      ...structuredClone(session.run),
      id: randomUUID(),
      fingerprint: this.fingerprint(session),
      state: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      sqlBaseState: wasComplete ? 'complete' : 'partial',
    };
    delete run.finishedAt;
    delete run.error;
    delete run.cacheRestored;
    delete run.testsBaseState;
    delete run.scenariosBaseState;
    session.run = run;
    this.store.saveSession(session);
    const controller = new AbortController();
    this.jobs.set(session.id, controller);
    const execution = this.executeSql(session, run, controller, wasComplete).finally(() => {
      this.jobs.delete(session.id);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
    return run;
  }
  private async executeSql(
    session: ReviewSession,
    run: AnalysisRun,
    controller: AbortController,
    wasComplete: boolean,
  ) {
    const emit = (message: string) => this.event(session, run, message);
    try {
      emit('Codex дополняет SQL. Сохранённый разбор PR остаётся прежним.');
      const model = await this.provider.analyze(
        {
          snapshots: session.snapshots,
          indexes: run.result.indexes,
          sqlOnly: true,
          sqlTargets: missingSqlMethods(session.snapshots, run.result.indexes, run.result.database),
        },
        controller.signal,
        emit,
      );
      controller.signal.throwIfAborted();
      const checked = await validateModelResult(model, session.snapshots);
      if (
        !checked.database.some((item) => item.query) &&
        run.result.indexes.some((index) =>
          index.methods.some(
            (method) =>
              !isTestPath(method.evidence.path) &&
              (method.callSites?.some((call) => call.database) ||
                /(?:Repository|Dao)\.(?:java|kt)$/.test(method.evidence.path)),
          ),
        )
      ) {
        throw new Error(
          'Codex не вернул SQL-артефакты с привязкой к методам. Предыдущее ревью сохранено; дополнение можно повторить.',
        );
      }
      const key = (item: DatabaseOperation) =>
        item.query
          ? JSON.stringify([
              item.query.evidence.repoId,
              item.query.evidence.side,
              item.query.evidence.path,
              item.query.method.replace(/\(\)$/, '').split('.').at(-1),
              item.query.evidence.startLine,
            ])
          : item.id;
      const updated = new Set(checked.database.map(key));
      run.result.database = [
        ...run.result.database.filter((item) => !updated.has(key(item))),
        ...checked.database,
      ];
      run.result.gaps = [...new Set([...run.result.gaps, ...checked.gaps])];
      const missing = missingSqlMethods(session.snapshots, run.result.indexes, run.result.database);
      if (missing.length) delete run.result.sqlAnalysisVersion;
      else run.result.sqlAnalysisVersion = SQL_ANALYSIS_VERSION;
      emit(
        `SQL: не разобрано методов ${missing.length}${missing.length ? ` (${missing.map((m) => m.name).join(', ')})` : ''}.`,
      );
      run.state = wasComplete && !missing.length ? 'complete' : 'partial';
      if (run.state === 'complete') this.store.saveAnalysisResult(run.fingerprint, run.result);
    } catch (error) {
      run.state = controller.signal.aborted ? 'cancelled' : 'partial';
      if (!controller.signal.aborted) {
        run.error = error instanceof Error ? error.message : String(error);
        emit(`Ошибка дополнения SQL: ${run.error}`);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      emit(`Дополнение SQL завершено: ${run.state}.`);
    }
  }
  start(session: ReviewSession): AnalysisRun {
    if (this.jobs.has(session.id)) throw new AppError('Анализ уже запущен.', 409);
    if (
      session.run?.result.summary &&
      missingScenarios(
        scenarioRoots(session.snapshots, session.run.result.indexes),
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
      events: [],
      ...(previous ? { previousReviewId: previous.id } : {}),
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
          message: 'Восстановлен проверенный анализ неизменённых коммитов из кэша.',
        },
      ];
      this.markIncompleteCatalog(run, session.snapshots);
    }
    session.run = run;
    this.store.saveSession(session);
    if (cached) return run;
    const controller = new AbortController();
    this.jobs.set(session.id, controller);
    const execution = this.execute(session, run, controller).finally(() => {
      this.jobs.delete(session.id);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
    return run;
  }
  cancel(id: string) {
    const controller = this.jobs.get(id);
    if (!controller) throw new AppError('Нет активного анализа.', 409);
    controller.abort();
  }
  isRunning(id: string) {
    return this.jobs.has(id);
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
  private event(session: ReviewSession, run: AnalysisRun, message: string) {
    const event = { seq: run.events.length + 1, at: new Date().toISOString(), message };
    run.events.push(event);
    this.store.saveSession(session);
    for (const listener of this.subscribers.get(session.id) ?? []) listener(event);
  }
  private async execute(session: ReviewSession, run: AnalysisRun, controller: AbortController) {
    const signal = controller.signal;
    let incomplete = false;
    const emit = (m: string) => this.event(session, run, m);
    try {
      emit('Индексирование зафиксированных снимков Git…');
      for (const snapshot of session.snapshots) {
        signal.throwIfAborted();
        for (const side of ['base', 'head'] as const) {
          try {
            const key = `${INDEX_VERSION}:${snapshot.repoId}:${side}:${side === 'head' ? snapshot.headSha : snapshot.mergeBase}`;
            const cached = this.store.index(key);
            const index = cached ?? (await indexSnapshot(snapshot, side, signal));
            if (!cached) this.store.saveIndex(key, index);
            else emit(`${snapshot.repoName}/${side}: использован индекс неизменённого коммита.`);
            run.result.indexes.push(index);
            if (index.errors.length) run.result.gaps.push(...index.errors);
          } catch (e) {
            signal.throwIfAborted();
            incomplete = true;
            run.result.gaps.push(`Индекс ${snapshot.repoName}/${side}: ${String(e)}`);
          }
        }
        try {
          run.result.contracts.push(...(await extractContracts(snapshot)));
        } catch (e) {
          incomplete = true;
          run.result.gaps.push(`Контракты ${snapshot.repoName}: ${String(e)}`);
        }
        for (const f of snapshot.files.filter((f) => /\.sql$/i.test(f.path))) {
          const side = snapshot.headFiles.includes(f.path) ? 'head' : 'base';
          const path = side === 'head' ? f.path : (f.oldPath ?? f.path);
          if (!(side === 'head' ? snapshot.headFiles : snapshot.baseFiles).includes(path)) continue;
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
            summary: side === 'head' ? 'SQL-файл в новой версии' : 'SQL-файл удалён',
            confidence: 'extracted',
            kind: /migration|liquibase|flyway|db\/changelog/i.test(path) ? 'migration' : 'sql',
            sql,
            dialect: 'Не определён',
            tables: [
              ...new Set(
                Array.from(
                  sql.matchAll(/\b(?:TABLE|INTO|UPDATE|FROM|JOIN)\s+([\w."`]+)/gi),
                  (m) => m[1],
                ),
              ),
            ],
            unknowns: ['Выполнение и план запроса не проверены'],
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
          run.result.database.push(op);
        }
        emit(`${snapshot.repoName}: индекс и контракты готовы.`);
      }
      const deterministic = run.result.database;
      const previous = session.history?.find((revision) => revision.id === run.previousReviewId);
      const model = await this.provider.analyze(
        {
          snapshots: session.snapshots,
          indexes: run.result.indexes,
          ...(previous
            ? {
                followUp: {
                  previousReviewId: previous.id,
                  previous: {
                    summary: previous.run.result.summary,
                    findings: previous.run.result.findings,
                    scenarios: previous.run.result.scenarios,
                    database: previous.run.result.database,
                    transactions: [],
                    gaps: previous.run.result.gaps,
                    tests: previous.run.result.tests,
                  },
                  comments: previous.drafts.flatMap((draft) =>
                    draft.comments.map((comment) => ({
                      ...comment,
                      repoId: previous.snapshots.find((s) => s.id === draft.snapshotId)?.repoId,
                    })),
                  ),
                  reviewBodies: previous.drafts
                    .filter((draft) => draft.body.trim())
                    .map((draft) => draft.body),
                  changes:
                    session.update?.previousReviewId === previous.id ? session.update.changes : [],
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
      emit('Проверка ссылок модели и диапазонов строк…');
      const checked = await validateModelResult(model, session.snapshots);
      if (previous) {
        checked.followUp ??= {
          summary:
            'Дополнительные результаты получены. По пунктам без отдельного ответа статус остаётся неизвестным.',
          items: [],
        };
        const ids = new Set([
          ...previous.run.result.findings.map((finding) => finding.id),
          ...previous.drafts.flatMap((draft) => draft.comments.map((comment) => comment.id)),
        ]);
        checked.followUp.items = checked.followUp.items.filter((item) => ids.has(item.previousId));
        const reported = new Set(checked.followUp.items.map((item) => item.previousId));
        for (const id of ids)
          if (!reported.has(id))
            checked.followUp.items.push({
              previousId: id,
              status: 'unknown',
              summary:
                'Результат проверки этого замечания или вопроса не получен. Требуется проверка.',
              evidence: [],
            });
      } else delete checked.followUp;
      const merged = previous
        ? await mergeIncremental(previous, session.snapshots, checked)
        : checked;
      Object.assign(run.result, {
        ...merged,
        database: [
          ...deterministic,
          ...merged.database.filter((item) => !deterministic.some((op) => op.id === item.id)),
        ],
        gaps: [...run.result.gaps, ...merged.gaps],
      });
      if (missingSqlMethods(session.snapshots, run.result.indexes, run.result.database).length)
        delete run.result.sqlAnalysisVersion;
      else run.result.sqlAnalysisVersion = SQL_ANALYSIS_VERSION;
      if (
        model.tests &&
        !missingTestMethods(session.snapshots, run.result.indexes, run.result.tests ?? []).length
      )
        run.result.testAnalysisVersion = TEST_ANALYSIS_VERSION;
      else delete run.result.testAnalysisVersion;
      run.scenariosBaseState = incomplete ? 'partial' : 'complete';
      if (!(await this.completeScenarios(session, run, signal))) incomplete = true;
      else delete run.scenariosBaseState;
      if (
        missingTestMethods(session.snapshots, run.result.indexes, run.result.tests ?? []).length
      ) {
        run.testsBaseState = incomplete ? 'partial' : 'complete';
        if (!(await this.completeTests(session, run, signal))) incomplete = true;
      }
      run.state = incomplete ? 'partial' : 'complete';
      if (run.state === 'complete') this.store.saveAnalysisResult(run.fingerprint, run.result);
    } catch (e) {
      if (signal.aborted) {
        run.state = 'cancelled';
        run.result.gaps.push('Анализ отменён пользователем.');
      } else {
        run.state = 'partial';
        run.error = e instanceof Error ? e.message : String(e);
        run.result.gaps.push(`Codex/анализ: ${run.error}`);
        emit(`Ошибка анализа: ${run.error}`);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      emit(`Анализ завершён: ${run.state}.`);
    }
  }
}
