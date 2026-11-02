import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk';
import { z } from 'zod';
import { mkdtemp, mkdir, copyFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyModelResult,
  type ModelResult,
  type Snapshot,
  type SourceIndex,
  type DraftComment,
  type ReviewUpdate,
  type IndexedMethod,
  type AnalysisModelCheckpoint,
  type ReviewTest,
  type ChangeCard,
} from '../shared/model.js';
import { readSource } from './repository.js';
import { codexHome } from './codex-login.js';
import { decodeModelResult } from './validation.js';
import { scenarioRoots, type ScenarioRoot } from '../shared/scenario-coverage.js';
import {
  prepareAnalysisWorkspace,
  localAnalysisPrompt,
  stageRefs,
  stageSnapshots,
} from './analysis-workspace.js';
import { fromWire, wireOutputSchema } from './wire-format.js';
import { testOutline } from './test-outline.js';
import { directlyChanged } from '../shared/analysis-scope.js';
import type { ChangeUnit } from '../shared/change-units.js';
import { cardsPrompt, cardsSchema, parseCards, type CardDraft } from './change-cards.js';
import { isTestPath, reviewTestMethods } from '../shared/test-coverage.js';
import { renderPrompt, type PromptOverrides } from '../shared/prompt-templates.js';
import { t } from '../shared/i18n.js';

export interface AnalysisInput {
  continuation?: { checkpoint: AnalysisModelCheckpoint; save: () => void };
  userMessages?: string[];
  onEvent?: (event: ThreadEvent) => void;
  scenariosOnly?: ScenarioRoot[];
  sqlOnly?: boolean;
  sqlTargets?: IndexedMethod[];
  testsOnly?: boolean;
  testTargets?: IndexedMethod[];
  snapshots: Snapshot[];
  indexes: SourceIndex[];
  /** Definitions of the changes made before the review turn. */
  changeCards?: ChangeCard[];
  followUp?: {
    previousReviewId: string;
    previous: ModelResult;
    comments: (DraftComment & { repoId?: string })[];
    reviewBodies: string[];
    changes: ReviewUpdate['changes'];
    discussion: ReviewUpdate['discussion'];
    discussionContext?: ReviewUpdate['discussion'];
    gaps: string[];
  };
}
export interface AnalysisProvider {
  id: string;
  /** Short definitions of small changes; providers without it skip the step. */
  describeChanges?(
    units: ChangeUnit[],
    signal: AbortSignal,
    onEvent?: (event: ThreadEvent) => void,
  ): Promise<(CardDraft | undefined)[]>;
  analyze(
    input: AnalysisInput,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<ModelResult>;
}
export async function buildContext(
  input: AnalysisInput,
): Promise<{ text: string; truncated: boolean }> {
  const LIMIT = 550_000;
  let remaining = LIMIT - 10_000,
    truncated = false;
  const consume = <T>(value: T): T | null => {
    const size = JSON.stringify(value).length;
    if (size > remaining) {
      truncated = true;
      return null;
    }
    remaining -= size;
    return value;
  };
  const snapshots: unknown[] = [],
    indexes: unknown[] = [],
    sources: unknown[] = [];
  const selected = new Map<string, Set<string>>();
  const rootCatalog = consume(
    (input.scenariosOnly ?? scenarioRoots(input.snapshots, input.indexes)).map(
      ({ paths, ...root }) => root,
    ),
  );
  const sqlCatalog = consume(
    (input.sqlTargets ?? []).map((method) => ({ name: method.name, evidence: method.evidence })),
  );
  const testCatalog = consume(
    (
      input.testTargets ??
      (!input.sqlOnly && !input.scenariosOnly
        ? reviewTestMethods(input.snapshots, input.indexes)
        : [])
    ).map((method) => ({ name: method.name, evidence: method.evidence })),
  );
  // Legacy transaction reports are retained in saved reviews, but never sent to Codex.
  const withoutTransactions = ({ transactions: _legacy, ...review }: ModelResult) => review;
  let followUp = input.followUp
    ? {
        ...input.followUp,
        previous: withoutTransactions(input.followUp.previous),
        discussion: input.followUp.discussion.map(
          ({ reactions: _reactions, ...comment }) => comment,
        ),
        discussionContext: input.followUp.discussionContext?.map(
          ({ reactions: _reactions, ...comment }) => comment,
        ),
      }
    : undefined;
  if (followUp && JSON.stringify(followUp).length > 160_000) {
    truncated = true;
    followUp = {
      ...followUp,
      previous: {
        ...withoutTransactions(emptyModelResult()),
        summary: followUp.previous.summary.slice(0, 8000),
        findings: followUp.previous.findings.slice(0, 30).map((finding) => ({
          ...finding,
          summary: finding.summary.slice(0, 1500),
          evidence: finding.evidence.slice(0, 4),
        })),
      },
      comments: followUp.comments
        .slice(0, 30)
        .map((comment) => ({ ...comment, body: comment.body.slice(0, 1500) })),
      reviewBodies: followUp.reviewBodies.slice(0, 10).map((body) => body.slice(0, 2000)),
      changes: followUp.changes.map((change) => ({
        ...change,
        files: change.files
          .slice(0, 50)
          .map((file) => ({ ...file, patch: '', addedLines: [], removedLines: [] })),
      })),
      discussion: followUp.discussion
        .slice(-30)
        .map((reply) => ({ ...reply, body: reply.body.slice(0, 1500) })),
      discussionContext: followUp.discussionContext
        ?.slice(-10)
        .map((reply) => ({ ...reply, body: reply.body.slice(0, 1500) })),
      gaps: [
        ...followUp.gaps,
        t(
          'The review history was shortened to fit the context limit. Do not treat missing items as fixed.',
        ),
      ],
    };
  }
  if (followUp && !consume(followUp))
    throw new Error(
      t('The review history exceeds the context limit. The previous review is kept.'),
    );
  const testClassFiles = new Set(
    reviewTestMethods(input.snapshots, input.indexes).map(
      (method) => `${method.evidence.repoId}:${method.evidence.path}`,
    ),
  );
  const selectedTest = (repoId: string, path: string) =>
    !input.testTargets?.length ||
    !testClassFiles.has(`${repoId}:${path}`) ||
    input.testTargets.some(
      (method) => method.evidence.repoId === repoId && method.evidence.path === path,
    );
  const contextFiles = (snapshot: Snapshot) =>
    input.scenariosOnly
      ? snapshot.files.filter((file) =>
          input.scenariosOnly!.some(
            (root) => root.evidence.repoId === snapshot.repoId && root.paths.includes(file.path),
          ),
        )
      : input.testsOnly
        ? snapshot.files.filter(
            (file) => isTestPath(file.path) && selectedTest(snapshot.repoId, file.path),
          )
        : input.sqlOnly
          ? snapshot.files.filter(
              (file) =>
                !isTestPath(file.path) &&
                (!input.sqlTargets?.length ||
                  input.sqlTargets.some(
                    (method) =>
                      method.evidence.repoId === snapshot.repoId &&
                      method.evidence.path === file.path,
                  ) ||
                  /\.(?:sql|ya?ml|properties|xml)$/.test(file.path)),
            )
          : (input.followUp?.changes.find((change) => change.repoId === snapshot.repoId)?.files ??
            snapshot.files);
  let patchBudget = 120_000;
  for (const s of input.snapshots) {
    selected.set(s.repoId, new Set(contextFiles(s).flatMap((f) => [f.path, f.oldPath ?? f.path])));
    for (const root of input.scenariosOnly ?? [])
      if (root.evidence.repoId === s.repoId)
        for (const path of root.paths) selected.get(s.repoId)!.add(path);
    for (const method of input.sqlTargets ?? [])
      if (method.evidence.repoId === s.repoId) selected.get(s.repoId)!.add(method.evidence.path);
    if (input.testsOnly)
      for (const path of s.headFiles.filter(
        (path) => isTestPath(path) && selectedTest(s.repoId, path),
      ))
        selected.get(s.repoId)!.add(path);
    if (input.followUp) {
      for (const ref of [
        ...input.followUp.previous.findings.flatMap((finding) => finding.evidence),
        ...input.followUp.comments.flatMap((comment) =>
          comment.evidence ? [comment.evidence] : [],
        ),
      ])
        if (ref.repoId === s.repoId) selected.get(s.repoId)!.add(ref.path);
    }
    const files = [];
    for (const f of contextFiles(s).filter(
      (f) => s.headFiles.includes(f.path) || s.baseFiles.includes(f.oldPath ?? f.path),
    )) {
      const bounded = { ...f, patch: f.patch.slice(0, 12_000) };
      if (bounded.patch.length < f.patch.length) truncated = true;
      const size = JSON.stringify(bounded).length;
      if (size > patchBudget) {
        truncated = true;
        continue;
      }
      const value = consume(bounded);
      if (value) {
        files.push(value);
        patchBudget -= size;
      }
    }
    const metadata = {
      repoId: s.repoId,
      name: s.repoName,
      slug: s.slug,
      pr: s.pr ? { number: s.pr.number, title: s.pr.title, body: s.pr.body.slice(0, 6000) } : null,
      ...(s.local ? { local: { baseRef: s.local.baseRef }, reviewTarget: true } : {}),
      headSha: s.headSha,
      mergeBase: s.mergeBase,
    };
    if (s.pr && s.pr.body.length > 6000) truncated = true;
    const value = consume(metadata);
    if (value) snapshots.push({ ...value, files });
  }
  // Spend at most a fifth of the context on the syntax index; reserve room for source.
  let indexBudget = 100_000;
  for (const index of input.indexes) {
    const methods = [];
    const ranked = [...index.methods].sort(
      (a, b) =>
        (input.testsOnly ? -1 : 1) *
          (Number(isTestPath(a.evidence.path)) - Number(isTestPath(b.evidence.path))) ||
        Number(selected.get(index.repoId)?.has(b.evidence.path)) -
          Number(selected.get(index.repoId)?.has(a.evidence.path)),
    );
    for (const method of ranked) {
      if (
        input.testsOnly &&
        isTestPath(method.evidence.path) &&
        !selectedTest(index.repoId, method.evidence.path)
      )
        continue;
      if (input.sqlOnly && isTestPath(method.evidence.path)) continue;
      if (input.scenariosOnly && !selected.get(index.repoId)?.has(method.evidence.path)) continue;
      // Exact sites already exist in numbered source; repeating their full paths per
      // invocation starved the index of most services and repositories.
      const compact = {
        name: method.name,
        signature: method.signature,
        annotations: method.annotations,
        calls: method.calls,
        evidence: method.evidence,
        programmaticTransactions: method.programmaticTransactions,
      };
      const size = JSON.stringify(compact).length;
      if (size > indexBudget) {
        truncated = true;
        continue;
      }
      const value = consume(compact);
      if (value) {
        methods.push(value);
        indexBudget -= size;
      }
    }
    indexes.push({
      repoId: index.repoId,
      side: index.side,
      methods,
      filesIndexed: index.filesIndexed,
      errors: index.errors.slice(0, 30),
    });
  }
  const queue: { s: Snapshot; side: 'base' | 'head'; path: string }[] = [];
  for (const method of input.testTargets ?? []) {
    const s = input.snapshots.find((snapshot) => snapshot.repoId === method.evidence.repoId);
    if (s) queue.push({ s, side: method.evidence.side, path: method.evidence.path });
  }
  for (const method of input.sqlTargets ?? []) {
    const s = input.snapshots.find((snapshot) => snapshot.repoId === method.evidence.repoId);
    if (s) queue.push({ s, side: method.evidence.side, path: method.evidence.path });
  }
  if (input.testsOnly)
    for (const s of input.snapshots)
      for (const path of s.headFiles.filter(
        (path) => isTestPath(path) && selectedTest(s.repoId, path),
      ))
        queue.push({ s, side: 'head', path });
  for (const s of input.snapshots)
    for (const f of contextFiles(s)) {
      if (s.headFiles.includes(f.path)) queue.push({ s, side: 'head', path: f.path });
      if (s.baseFiles.includes(f.oldPath ?? f.path))
        queue.push({ s, side: 'base', path: f.oldPath ?? f.path });
    }
  // Changes first across all services, then surrounding methods and configuration.
  for (const s of input.snapshots)
    for (const path of selected.get(s.repoId) ?? []) {
      if (s.headFiles.includes(path)) queue.push({ s, side: 'head', path });
    }
  for (const s of input.snapshots)
    for (const path of s.headFiles.filter((p) => /\.(java|kt|properties|ya?ml|xml|sql)$/.test(p)))
      if (
        (!input.sqlOnly || !isTestPath(path)) &&
        (!input.testsOnly || !isTestPath(path) || selectedTest(s.repoId, path)) &&
        (!input.scenariosOnly ||
          selected.get(s.repoId)?.has(path) ||
          /\.(ya?ml|properties|xml)$/.test(path))
      )
        queue.push({ s, side: 'head', path });
  const seen = new Set<string>();
  for (const { s, side, path } of queue) {
    const key = `${s.repoId}:${side}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (remaining < 2000) {
      truncated = true;
      break;
    }
    const text = await readSource(s, { side, path });
    const numbered = text
      .slice(0, 25_000)
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n');
    if (text.length > 25_000) truncated = true;
    const value = consume({ repoId: s.repoId, side, path, text: numbered });
    if (value) sources.push(value);
  }
  const text = JSON.stringify({
    snapshots,
    indexes,
    sources,
    followUp,
    sqlOnly: input.sqlOnly ?? false,
    sqlTargets: sqlCatalog ?? [],
    testsOnly: input.testsOnly ?? false,
    testTargets: testCatalog ?? [],
    scenariosOnly: !!input.scenariosOnly,
    scenarioRoots: rootCatalog ?? [],
    truncated,
  });
  if (text.length > LIMIT) throw new Error(t('The analysis metadata exceeds the context limit.'));
  return { text, truncated };
}
export function codexOptions(home: string): { options: CodexOptions; thread: ThreadOptions } {
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
  };
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return {
    options: {
      env,
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
      config: {
        features: { shell_tool: false, multi_agent: false },
        // Nothing is inherited, but the shell still needs the system tools (cat, sed, nl).
        shell_environment_policy: {
          inherit: 'none',
          set: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        },
        // No user configuration or MCP servers are loaded from the real home.
      },
      ...(process.env.REVIEW_CODEX_BIN ? { codexPathOverride: process.env.REVIEW_CODEX_BIN } : {}),
    },
    thread: {
      workingDirectory: home,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      ...(process.env.REVIEW_CODEX_MODEL ? { model: process.env.REVIEW_CODEX_MODEL } : {}),
    },
  };
}
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_ITEMS = ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'];

/** Consume a tool-less analysis turn and return its parsed final message. */
export async function readAnalysisResponse(
  events: AsyncIterable<ThreadEvent>,
  signal: AbortSignal,
  timeout: AbortSignal,
  localTools = false,
): Promise<unknown> {
  let final = '';
  try {
    for await (const event of events) {
      signal.throwIfAborted();
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'turn.failed') throw new Error(event.error.message);
      if (event.type === 'item.completed' && event.item.type === 'agent_message')
        final = event.item.text;
      if (
        (event.type === 'item.started' || event.type === 'item.completed') &&
        TOOL_ITEMS.includes(event.item.type) &&
        !(localTools && event.item.type === 'command_execution')
      )
        throw new Error(
          t('Codex tried to use a tool in an analysis without tools. The analysis stopped.'),
        );
    }
  } catch (error) {
    if (timeout.aborted && !signal.aborted)
      throw new Error(
        t(
          'Codex did not answer within {0} minutes. The analysis stopped; run it again.',
          ANALYSIS_TIMEOUT_MS / 60_000,
        ),
      );
    throw error;
  }
  if (!final.trim()) throw new Error(t('Codex finished without returning an analysis result.'));
  try {
    return JSON.parse(final);
  } catch {
    throw new Error(t('Codex returned a result that is not JSON.'));
  }
}
export class CodexProvider implements AnalysisProvider {
  constructor(private readonly promptOverrides: () => PromptOverrides = () => ({})) {}
  id = 'codex-sdk-v5-local-scope';
  async analyze(input: AnalysisInput, signal: AbortSignal, progress: (message: string) => void) {
    signal.throwIfAborted();
    const checkpoint = input.continuation?.checkpoint;
    const prompts =
      checkpoint?.promptOverrides ?? (checkpoint?.started ? {} : this.promptOverrides());
    if (checkpoint && !checkpoint.promptOverrides) {
      checkpoint.promptOverrides = prompts;
      input.continuation!.save();
    }
    const home = checkpoint?.home ?? (await mkdtemp(join(tmpdir(), 'review-codex-')));
    if (checkpoint) {
      checkpoint.home = home;
      input.continuation!.save();
    }
    try {
      await copyAuth(home);
      const workspace = await prepareAnalysisWorkspace(home, input);
      if (checkpoint) {
        checkpoint.localWorkspace = true;
        input.continuation!.save();
      }
      if (input.testsOnly)
        return await this.describeTests(input, home, workspace, signal, progress, prompts);
      progress(
        input.scenariosOnly
          ? t('Codex is completing missing scenarios; the main review is saved…')
          : input.sqlOnly
            ? t('Codex is generating SQL from the repository code and helper methods…')
            : t('Codex is reading local changes and building the affected diagrams…'),
      );
      const answer = await runTurn(input, home, workspace, {
        prompt: localAnalysisPrompt(input, input.userMessages, prompts),
        schema: wireOutputSchema,
        tools: true,
        signal,
      });
      const result = decodeModelResult(fromWire(answer, stageRefs(input)));
      result.transactions = [];
      result.tests = [];
      if (input.sqlOnly) {
        result.summary = '';
        result.findings = [];
        result.scenarios = [];
        delete result.followUp;
      } else result.database = [];
      return result;
    } finally {
      // A kept conversation is resumed later; the copied credentials are copied again then.
      if (!checkpoint) await rm(home, { recursive: true, force: true });
      else await removeAuth(home);
    }
  }

  async describeChanges(
    units: ChangeUnit[],
    signal: AbortSignal,
    onEvent?: (event: ThreadEvent) => void,
  ) {
    const home = await mkdtemp(join(tmpdir(), 'review-codex-'));
    try {
      await copyAuth(home);
      const answer = await runTurn({ snapshots: [], indexes: [], onEvent }, home, home, {
        prompt: cardsPrompt(units, this.promptOverrides()),
        schema: cardsSchema,
        tools: false,
        signal,
      });
      return parseCards(answer, units.length);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  /** Test steps come from the index; the model only names each test and says what it checks. */
  private async describeTests(
    input: AnalysisInput,
    home: string,
    workspace: string,
    signal: AbortSignal,
    progress: (message: string) => void,
    prompts: PromptOverrides,
  ): Promise<ModelResult> {
    const targets = (input.testTargets ?? []).filter((method) =>
      directlyChanged(method, stageSnapshots(input)),
    );
    const tests: ReviewTest[] = [];
    const listing: string[] = [];
    for (const [i, method] of targets.entries()) {
      const snapshot = input.snapshots.find((s) => s.repoId === method.evidence.repoId);
      if (!snapshot) continue;
      const lines = (await readSource(snapshot, method.evidence)).split('\n');
      const { startLine, endLine } = method.evidence;
      const body = lines
        .slice(startLine - 1, Math.min(endLine, startLine + 79))
        .map((line, n) => `${startLine + n}: ${line}`);
      listing.push(`### T${i + 1} ${method.name}\n${body.join('\n')}`);
      const owner = method.evidence.path
        .split('/')
        .pop()!
        .replace(/\.\w+$/, '');
      tests.push({
        id: `test:${method.evidence.path}:${startLine}`,
        title: method.name,
        summary: '',
        confidence: 'extracted',
        evidence: [method.evidence],
        method: `${owner}.${method.name}`,
        steps: testOutline(method, lines),
      });
    }
    if (!tests.length) return { ...emptyModelResult(), tests: [] };
    progress(t('Codex is naming {0} changed tests and describing what they check…', tests.length));
    const answer = await runTurn(input, home, workspace, {
      prompt: testTitlesPrompt(listing, prompts),
      schema: testTitlesSchema,
      tools: false,
      signal,
    });
    const named = new Map(
      (testTitles.safeParse(answer).data?.tests ?? []).map((test) => [test.id, test]),
    );
    const result = emptyModelResult();
    result.tests = tests.map((test, i) => {
      const described = named.get(`T${i + 1}`);
      return described
        ? { ...test, title: described.title, summary: described.summary }
        : { ...test, confidence: 'unknown' as const };
    });
    if (named.size < tests.length)
      result.gaps.push(t('Codex did not describe some changed tests.'));
    return result;
  }
}

/** Codex reads its login from the private home; with an API key nothing is copied. */
export async function copyAuth(home: string) {
  const privateHome = join(home, '.codex');
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  if (process.env.OPENAI_API_KEY) return;
  try {
    await copyFile(join(codexHome(), 'auth.json'), join(privateHome, 'auth.json'));
    await chmod(join(privateHome, 'auth.json'), 0o600);
  } catch {
    throw new Error(
      t('Codex is not connected. Open the user menu at the bottom left → Connect Codex.'),
    );
  }
}
export const removeAuth = (home: string) => rm(join(home, '.codex', 'auth.json'), { force: true });

const testTitles = z.object({
  tests: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })),
});
export const testTitlesSchema = z.toJSONSchema(testTitles);
export function testTitlesPrompt(listing: string[], overrides: PromptOverrides = {}) {
  return renderPrompt('tests', { tests: listing.join('\n\n') }, overrides);
}

/** One Codex turn in the pinned workspace, resumable from the checkpoint. */
async function runTurn(
  input: AnalysisInput,
  home: string,
  workspace: string,
  turn: { prompt: string; schema: unknown; tools: boolean; signal: AbortSignal },
) {
  const checkpoint = input.continuation?.checkpoint;
  const opts = codexOptions(home);
  opts.thread.workingDirectory = workspace;
  opts.options.config = {
    ...opts.options.config,
    features: { shell_tool: turn.tools, multi_agent: false },
  };
  const codex = new Codex(opts.options);
  const thread = checkpoint?.threadId
    ? codex.resumeThread(checkpoint.threadId, opts.thread)
    : codex.startThread(opts.thread);
  const timeout = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
  const continuing = checkpoint?.started;
  if (checkpoint) {
    checkpoint.started = true;
    input.continuation!.save();
  }
  const { events } = await thread.runStreamed(
    (continuing ? renderPrompt('continuation', {}, checkpoint?.promptOverrides) + '\n' : '') +
      turn.prompt,
    {
      signal: AbortSignal.any([turn.signal, timeout]),
      outputSchema: turn.schema,
    },
  );
  async function* savedEvents() {
    for await (const event of events) {
      if (checkpoint && event.type === 'thread.started') {
        checkpoint.threadId = event.thread_id;
        input.continuation!.save();
      }
      input.onEvent?.(event);
      yield event;
    }
  }
  return readAnalysisResponse(savedEvents(), turn.signal, timeout, turn.tools);
}
