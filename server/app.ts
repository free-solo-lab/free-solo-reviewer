import { restoreReviewBranch } from '../shared/review-branch.js';
import Fastify from 'fastify';
import { SERVICE_NAME, SERVICE_PROTOCOL, type ReviewerRuntime } from '../shared/runtime.js';
import { backfillStatistics } from './analysis-statistics.js';
import { statisticSummary } from '../shared/analysis-statistics.js';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  promptTemplates,
  promptSettings,
  validatePrompt,
  type PromptId,
} from '../shared/prompt-templates.js';
import { Store } from './store.js';
import { packIndex } from '../shared/index-wire.js';
import { extractAllContracts, CONTRACTS_VERSION } from './contracts.js';
import { FixChats, type FixProvider } from './fix-chat.js';
import { terminalInput, Terminals, type TerminalOutput } from './terminals.js';
import { checkoutPullRequest, readWorkingFile, writeWorkingFile } from './working-files.js';
import { GitHub, type GitHubGateway } from './github.js';
import { GitHubLogin } from './github-login.js';
import { CodexLogin, codexAuth } from './codex-login.js';
import { Feedback, type FeedbackGateway } from './feedback.js';
import { feedbackKindIds } from '../shared/feedback.js';
import { indexSnapshot, INDEX_VERSION, storedIndex } from './indexer.js';
import { AnalysisManager } from './analysis.js';
import { CodexProvider, type AnalysisProvider } from './provider.js';
import { ReviewManager } from './review.js';
import { pickDirectory } from './directory-picker.js';
import {
  connectRepository,
  defaultLocalBase,
  localBranches,
  refreshRemoteBase,
  createSnapshot,
  createLocalSnapshot,
  readSource,
  changedFiles,
  workingSources,
  snapshotContent,
} from './repository.js';
import { archiveReview } from './revisions.js';
import { sqlPreview } from './sql-preview.js';
import { databaseSchema } from './database-schema.js';
import { REACTION_CONTENTS } from '../shared/reactions.js';
import { codeComparison } from './code-comparison.js';
import { ReviewComparisons } from './review-comparison.js';
import { PullRequestWorkflow } from './pull-request-workflow.js';
import { Discussions, ownReviewDiscussion } from './discussion.js';
import { restoreDiscussionOnlyReview } from '../shared/review-display.js';
import { sessionListItem } from '../shared/session-list.js';
import { ViewedMethods } from './viewed-methods.js';
import { ViewedFiles } from './viewed-files.js';
import { AppError, command, git } from './process.js';
import {
  sessionSnapshots,
  type AnalysisRun,
  type ReviewSession,
  type ReviewDraft,
  type Snapshot,
  type Repository,
  type GitHubAccounts,
  GITHUB_LOGIN,
} from '../shared/model.js';
import { errorMessage } from '../shared/errors.js';
import { onDemandStepIds, optionalStepIds } from '../shared/analysis-steps.js';
import {
  LANGUAGES,
  getLanguage,
  isLanguage,
  languageLabels,
  languageOf,
  setLanguage,
  t,
} from '../shared/i18n.js';
import { sourceIdentity, ensureReviewWorkflow } from '../shared/review-workflow.js';
import { remapEvidence } from './source-remap.js';
import { snapshotDiff } from './snapshot-diff.js';

/** Without a saved choice: REVIEW_LANGUAGE, then the system locale; English otherwise. */
export function defaultLanguage(env: NodeJS.ProcessEnv = process.env) {
  if (isLanguage(env.REVIEW_LANGUAGE)) return env.REVIEW_LANGUAGE;
  return languageOf(
    env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale,
  );
}
/** Serialized indexes kept in memory; a large one takes a few MB. */
const PACKED_INDEX_LIMIT = 24;
export function createApp(
  options: {
    dataDir?: string;
    webDir?: string;
    runtime?: ReviewerRuntime;
    github?: GitHubGateway;
    provider?: AnalysisProvider;
    port?: number;
    demo?: boolean;
    chooseDirectory?: () => Promise<string | null>;
    fixProvider?: FixProvider;
    githubLogin?: GitHubLogin;
    codexLogin?: CodexLogin;
    /** GitHub for feedback issues; the demo has none. */
    feedback?: FeedbackGateway;
  } = {},
) {
  const dataDir = resolve(options.dataDir ?? process.env.REVIEW_DATA_DIR ?? '.review');
  const store = new Store(join(dataDir, 'review.sqlite'));
  setLanguage(store.language() ?? defaultLanguage());
  store.recover();
  backfillStatistics(store);
  const connected = (slug: string) =>
    store.repositories().filter((repo) => repo.slug.toLowerCase() === slug.toLowerCase());
  // A repository's own account wins; otherwise the user chosen in the app; otherwise gh's active.
  const github =
    options.github ??
    new GitHub(
      (slug) =>
        (slug && connected(slug).find((repo) => repo.githubUser)?.githubUser) || store.githubUser(),
    );
  const analysis = new AnalysisManager(
    store,
    options.provider ?? new CodexProvider(() => store.promptOverrides()),
  );
  const review = new ReviewManager(store, github);
  const viewedFiles = new ViewedFiles(store);
  const viewedMethods = new ViewedMethods(store);
  const discussions = new Discussions(store, github, (id) => analysis.session(id));
  const comparisons = new ReviewComparisons(store);
  const publications = new PullRequestWorkflow(store, github, dataDir);
  const fixes = new FixChats(store, dataDir, options.fixProvider, async (id, _repoId, turnId) => {
    await exclusive(id, async () => {
      const current = session(id),
        workflow = ensureReviewWorkflow(current);
      if (workflow.fixUpdates?.[turnId]?.state === 'complete') return;
      workflow.fixUpdates ??= {};
      workflow.fixUpdates[turnId] = { state: 'pending', at: new Date().toISOString() };
      store.saveSession(current);
      try {
        await refreshSession(id, { analyze: true }, _repoId);
        const updated = session(id);
        ensureReviewWorkflow(updated).fixUpdates![turnId] = {
          state: 'complete',
          at: new Date().toISOString(),
        };
        store.saveSession(updated);
      } catch (e) {
        const updated = session(id);
        ensureReviewWorkflow(updated).fixUpdates![turnId] = {
          state: 'failed',
          at: new Date().toISOString(),
          error: errorMessage(e),
        };
        store.saveSession(updated);
        throw e;
      }
    });
  });
  const terminals = new Terminals(join(dataDir, 'terminal'));
  // Index keys (version:repo:side:sha) exceed the default 100-character parameter limit.
  const app = Fastify({
    logger: false,
    bodyLimit: 2_000_000,
    routerOptions: { maxParamLength: 300 },
  });
  const port = options.port ?? Number(process.env.REVIEW_PORT ?? 4318);
  const runtime: ReviewerRuntime = options.runtime ?? {
    service: SERVICE_NAME,
    protocol: SERVICE_PROTOCOL,
    pid: process.pid,
    dataDir,
    instanceId: randomUUID(),
  };
  app.get('/api/runtime', async () => runtime);
  const mutations = new Set<string>();
  const exclusive = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    if (mutations.has(id))
      throw new AppError(t('An operation on this session is already running.'), 409);
    mutations.add(id);
    try {
      return await fn();
    } finally {
      mutations.delete(id);
    }
  };
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: t('Only local access is allowed.') });
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ]).has(origin)
    )
      return reply.code(403).send({ error: t('Origin not allowed.') });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: t('Cross-site requests are not allowed.') });
    if (
      ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) &&
      !req.headers['content-type']?.startsWith('application/json')
    )
      return reply.code(415).send({ error: t('application/json is required.') });
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  // Hashed assets can be cached; the HTML shell must always revalidate after an update.
  app.addHook('onSend', async (_req, reply, payload) => {
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html'))
      reply.header('Cache-Control', 'no-cache');
    return payload;
  });
  // A refused WebSocket upgrade would otherwise keep its connection open.
  app.addHook('onResponse', async (req, reply) => {
    if (req.headers.upgrade && reply.statusCode >= 400) req.raw.socket.destroy();
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    reply.code(error instanceof AppError ? error.status : 500).send({
      error: error instanceof Error ? error.message : t('Application error'),
      ...(error instanceof AppError && error.code && { code: error.code }),
    });
  });
  // Indexes are served once from /api/indexes/:ref; responses carry only their references.
  app.addHook('preSerialization', async (_req, _reply, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return payload;
    if ('snapshots' in payload && 'run' in payload)
      return store.detachSession(payload as ReviewSession);
    if ('fingerprint' in payload && 'result' in payload) {
      const run = payload as AnalysisRun;
      return { ...run, result: { ...run.result, indexes: [] } };
    }
    return payload;
  });
  // Serialized once: an index is immutable, and every open review asks for the same few.
  const packedIndexes = new Map<string, string>();
  app.get<{ Params: { ref: string } }>('/api/indexes/:ref', async (req, reply) => {
    const { ref } = req.params;
    let body = packedIndexes.get(ref);
    if (body) packedIndexes.delete(ref);
    else {
      const index = store.index(ref);
      if (!index) throw new AppError(t('Index not found.'), 404);
      body = JSON.stringify(packIndex(index));
    }
    packedIndexes.set(ref, body);
    if (packedIndexes.size > PACKED_INDEX_LIMIT)
      packedIndexes.delete(packedIndexes.keys().next().value!);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type('application/json; charset=utf-8').send(body);
  });
  const session = (id: string) => {
    const s = store.session(id);
    if (!s) throw new AppError(t('Session not found.'), 404);
    return s;
  };
  const findSnapshot = (snapshots: Snapshot[], id: string) => {
    const item = snapshots.find((x) => x.id === id);
    if (!item) throw new AppError(t('Snapshot not found.'), 404);
    return item;
  };
  /** A snapshot of the current review. */
  const snapshot = (s: ReviewSession, id: string) => findSnapshot(s.snapshots, id);
  /** A snapshot of the current review or of an archived revision. */
  const anySnapshot = (s: ReviewSession, id: string) =>
    comparisons.snapshot(s, id) ?? findSnapshot(sessionSnapshots(s), id);
  const awaitingGitHub = (drafts: ReviewDraft[]) =>
    drafts.some((draft) => ['submitting', 'uncertain'].includes(draft.state));
  app.get<{ Params: { id: string } }>('/api/sessions/:id/fix-chat', async (req) => {
    session(req.params.id);
    return store.fixChat(req.params.id) ?? null;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/fix-completions', async (req) => {
    session(req.params.id);
    return store.fixChat(req.params.id)?.completedSteps ?? [];
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/fix-chat/retry-update', (req) =>
    fixes.retryUpdate(req.params.id),
  );
  app.get('/api/fix-chat/attention', async () =>
    store.pendingFixChats().map(({ chat, title }) => ({
      sessionId: chat.sessionId,
      title,
      requestId: chat.pending!.id,
      kind: chat.pending!.kind,
      prompt: chat.pending!.prompt,
    })),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/fix-chat/respond', async (req) =>
    exclusive(req.params.id, async () => {
      session(req.params.id);
      const input = z
        .object({
          requestId: z.string(),
          answer: z.string().max(20_000).optional(),
          approved: z.boolean().optional(),
          acceptChanges: z.boolean().optional(),
        })
        .parse(req.body);
      return fixes.respond(
        req.params.id,
        input.requestId,
        input.answer,
        input.approved,
        input.acceptChanges,
      );
    }),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/fix-chat', async (req) =>
    exclusive(req.params.id, async () => {
      const input = z
        .object({
          repoId: z.string(),
          action: z.enum(['plan', 'apply', 'step']),
          message: z.string().max(20_000).default(''),
          stepId: z.string().optional(),
          commentIds: z.array(z.string().min(1)).min(1).max(100).optional(),
          together: z.boolean().optional(),
          all: z.boolean().optional(),
          acceptChanges: z.boolean().optional(),
        })
        .parse(req.body);
      return fixes.start(req.params.id, input.repoId, input.action, input.message, undefined, {
        stepId: input.stepId,
        commentIds: input.commentIds,
        together: input.together,
        all: input.all,
        acceptChanges: input.acceptChanges,
      });
    }),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/fix-chat/skip', async (req) =>
    exclusive(req.params.id, async () => {
      session(req.params.id);
      const input = z
        .object({ repoId: z.string(), commentId: z.string(), skipped: z.boolean().default(true) })
        .parse(req.body);
      return fixes.skip(req.params.id, input.repoId, input.commentId, input.skipped);
    }),
  );
  // Manual edits go to the repository's working folder; the review sees them after a refresh.
  const editable = (id: string, repoId: string) => {
    const snapshot = session(id).snapshots.find(
      (item) => item.repoId === repoId && (item.local || item.pr),
    );
    const repo = store.repository(repoId);
    if (!snapshot || !repo) throw new AppError(t('This repository has no working folder.'), 404);
    if (fixes.isRepositoryRunning(repoId))
      throw new AppError(t('Codex is editing this folder right now. Wait until it finishes.'), 409);
    return { snapshot, repo };
  };
  app.get<{ Params: { id: string }; Querystring: { repoId: string; path: string } }>(
    '/api/sessions/:id/working-file',
    async (req) => {
      const { repoId, path } = z
        .object({ repoId: z.string(), path: z.string().min(1).max(1000) })
        .parse(req.query);
      const { snapshot, repo } = editable(req.params.id, repoId);
      return readWorkingFile(repo, snapshot, path);
    },
  );
  app.put<{ Params: { id: string } }>('/api/sessions/:id/working-file', async (req) => {
    const input = z
      .object({
        repoId: z.string(),
        path: z.string().min(1).max(1000),
        hash: z.string().length(64),
        content: z.string().max(1_000_000),
      })
      .parse(req.body);
    const { snapshot, repo } = editable(req.params.id, input.repoId);
    const saved = await writeWorkingFile(repo, snapshot, input.path, input.hash, input.content);
    // Own edits are known, so Codex can accept the folder later without a refresh.
    const edits = store.ownEdits(req.params.id, input.repoId) ?? { files: {} };
    edits.files[input.path] = {
      before: edits.files[input.path]?.before ?? saved.previous,
      after: saved.hash,
    };
    store.saveOwnEdits(req.params.id, input.repoId, edits);
    return { hash: saved.hash };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/checkout', async (req) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(req.body);
    const { snapshot, repo } = editable(req.params.id, repoId);
    return checkoutPullRequest(repo, snapshot);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/fix-chat/cancel', async (req) => {
    session(req.params.id);
    fixes.cancel(req.params.id);
    return { ok: true };
  });
  // A shell in the folder of a reviewed repository. Only the app's own page may open it: a
  // WebSocket is not limited by CORS, so a missing or foreign Origin is refused.
  app.register(websocket, { options: { maxPayload: 1_000_000 } });
  app.register(async (scoped) => {
    scoped.get<{ Params: { id: string }; Querystring: { repoId: string } }>(
      '/api/sessions/:id/terminal',
      { websocket: true },
      (socket, req) => {
        const send = (message: TerminalOutput) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        };
        const repoId = String(req.query.repoId ?? '');
        const repo = store.repository(repoId);
        if (
          !req.headers.origin ||
          !repo ||
          !store.session(req.params.id)?.snapshots.some((item) => item.repoId === repoId)
        ) {
          socket.close(1008, 'forbidden');
          return;
        }
        const shell = terminals.attach(repoId, repo.path, { send });
        socket.on('message', (raw) => {
          try {
            shell.receive(terminalInput.parse(JSON.parse(String(raw))));
          } catch {
            /* A malformed message is ignored; the shell keeps running. */
          }
        });
        socket.on('close', shell.detach);
      },
    );
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/status', async () => {
    let login: string | null = null,
      githubError: string | null = null,
      codex: string | null = null;
    try {
      login = (await github.user()).login;
    } catch (e) {
      githubError = errorMessage(e);
    }
    try {
      codex = (
        await command(process.env.REVIEW_CODEX_BIN ?? 'codex', ['--version'], { timeout: 5000 })
      ).trim();
    } catch {
      /* SDK bundles a CLI as well. */
    }
    return {
      login,
      githubError,
      codex,
      codexAuth: codexAuth(),
      demo: options.demo ?? false,
      provider: options.provider?.id ?? 'Codex SDK',
      model: process.env.REVIEW_CODEX_MODEL ?? 'default',
      dataDir,
    };
  });
  const refreshLocalRepository = async (repo: Repository) => {
    if (!repo.slug.startsWith('local/')) return repo;
    try {
      const detected = await connectRepository(repo.path);
      if (detected.slug !== repo.slug) {
        const updated = { ...repo, slug: detected.slug };
        store.saveRepository(updated);
        return updated;
      }
    } catch {
      /* A missing checkout can still be shown in the repository list. */
    }
    return repo;
  };
  app.get('/api/settings/prompts', async () => promptSettings(store.promptOverrides()));
  const languageSettings = () => ({
    language: getLanguage(),
    languages: LANGUAGES.map((id) => ({ id, label: languageLabels[id] })),
  });
  app.get('/api/settings/language', async () => languageSettings());
  app.put('/api/settings/language', async (req) => {
    const { language } = z
      .object({ language: z.enum(LANGUAGES) })
      .strict()
      .parse(req.body);
    store.saveLanguage(language);
    setLanguage(language);
    return languageSettings();
  });
  const stepSettings = () => ({
    disabled: store.disabledSteps(),
    onDemand: store.onDemandSteps(),
  });
  app.get('/api/settings/steps', async () => stepSettings());
  app.put('/api/settings/steps', async (req) => {
    const { disabled, onDemand } = z
      .object({
        disabled: z.array(z.enum(optionalStepIds)).max(20),
        onDemand: z.array(z.enum(onDemandStepIds)).max(20).optional(),
      })
      .strict()
      .parse(req.body);
    store.saveDisabledSteps([...new Set(disabled)]);
    if (onDemand) store.saveOnDemandSteps([...new Set(onDemand)]);
    return stepSettings();
  });
  app.get('/api/settings/statistics', async () => {
    backfillStatistics(store);
    return store
      .analysisStatistics()
      .map(statisticSummary)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  });
  app.get<{ Params: { id: string } }>('/api/settings/statistics/:id', async (req) => {
    const stat = store.analysisStatistic(req.params.id);
    if (!stat) throw new AppError(t('Analysis run not found.'), 404);
    return stat;
  });
  app.put<{ Params: { id: string } }>('/api/settings/prompts/:id', async (req) => {
    const definition = promptTemplates.find((prompt) => prompt.id === req.params.id);
    if (!definition) throw new AppError(t('Prompt template not found.'), 404);
    const { template } = z
      .object({ template: z.string().max(50000).nullable() })
      .strict()
      .parse(req.body);
    if (template !== null) {
      try {
        validatePrompt(definition.id, template);
      } catch (error) {
        throw new AppError((error as Error).message);
      }
    }
    const overrides = store.promptOverrides();
    if (template === null || template === definition.template)
      delete overrides[definition.id as PromptId];
    else overrides[definition.id as PromptId] = template;
    store.savePromptOverrides(overrides);
    return promptSettings(overrides).find((prompt) => prompt.id === definition.id)!;
  });
  app.get('/api/repositories', async () =>
    Promise.all(
      store.repositories().map(async (saved) => {
        const repo = await refreshLocalRepository(saved);
        return { ...repo, defaultLocalBase: await defaultLocalBase(repo) };
      }),
    ),
  );
  let directoryPickerOpen = false;
  app.post('/api/repositories/pick-directory', async (req) => {
    z.object({}).strict().parse(req.body);
    if (directoryPickerOpen) throw new AppError(t('The folder picker is already open.'), 409);
    directoryPickerOpen = true;
    try {
      return { path: await (options.chooseDirectory ?? pickDirectory)() };
    } finally {
      directoryPickerOpen = false;
    }
  });
  app.post('/api/repositories', async (req) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
    const repo = await connectRepository(path);
    const old = store.repositories().find((r) => r.path === repo.path);
    if (old) {
      const updated = { ...old, slug: repo.slug };
      store.saveRepository(updated);
      return { ...updated, defaultLocalBase: await defaultLocalBase(updated) };
    }
    store.saveRepository(repo);
    return { ...repo, defaultLocalBase: await defaultLocalBase(repo) };
  });
  const githubAccounts = async (): Promise<GitHubAccounts> => {
    const accounts = github.accounts ? await github.accounts() : { active: null, accounts: [] };
    const chosen = store.githubUser();
    return { ...accounts, current: chosen ?? accounts.active };
  };
  /** Only accounts gh is logged in to may act; a login is never passed on unchecked. */
  const loggedIn = async (login: string) => {
    if (!(await githubAccounts()).accounts.includes(login))
      throw new AppError(t('Account {0} is not signed in to gh. Sign in to it.', login));
  };
  const githubLoginInput = (body: unknown) =>
    z
      .object({ githubUser: z.string().regex(GITHUB_LOGIN).nullable() })
      .strict()
      .parse(body).githubUser;
  app.get('/api/github/accounts', githubAccounts);
  app.put('/api/github/current', async (req) => {
    const login = githubLoginInput(req.body);
    if (login) await loggedIn(login);
    store.saveGitHubUser(login);
    return githubAccounts();
  });
  app.get('/api/github/review-requests', async (req) => {
    const { login } = z
      .object({ login: z.string().regex(GITHUB_LOGIN).optional() })
      .parse(req.query);
    if (!github.reviewRequests) return [];
    if (login) await loggedIn(login);
    return (await github.reviewRequests(login)).map((request) => ({
      ...request,
      repoId: connected(request.slug)[0]?.id,
    }));
  });
  const githubLogin = options.githubLogin ?? new GitHubLogin();
  app.get('/api/github/login', async () => githubLogin.status());
  app.post('/api/github/login', async (req) => {
    z.object({}).strict().parse(req.body);
    return githubLogin.start();
  });
  app.post('/api/github/login/cancel', async (req) => {
    z.object({}).strict().parse(req.body);
    githubLogin.cancel();
    return githubLogin.status();
  });
  // Feedback is written by the user chosen in the app, whatever account a repository uses.
  const feedbackGateway =
    options.feedback ?? (options.demo ? undefined : new GitHub(() => store.githubUser()));
  const feedback = feedbackGateway && new Feedback(store, feedbackGateway);
  const withFeedback = () => {
    if (!feedback) throw new AppError(t('Feedback is not available in the demo.'), 503);
    return feedback;
  };
  const issueNumber = (value: string) => z.coerce.number().int().positive().parse(value);
  app.get('/api/feedback', async () => withFeedback().list());
  app.post('/api/feedback', async (req) => {
    const body = z
      .object({
        kind: z.enum(feedbackKindIds),
        title: z.string().trim().min(3).max(200),
        body: z.string().trim().min(1).max(20_000),
        diagnostics: z.boolean(),
      })
      .strict()
      .parse(req.body);
    return withFeedback().create(body.kind, body.title, body.body, body.diagnostics);
  });
  app.get<{ Params: { number: string } }>('/api/feedback/:number', async (req) =>
    withFeedback().thread(issueNumber(req.params.number)),
  );
  app.post<{ Params: { number: string } }>('/api/feedback/:number/comments', async (req) => {
    const { body } = z
      .object({ body: z.string().trim().min(1).max(20_000) })
      .strict()
      .parse(req.body);
    return withFeedback().reply(issueNumber(req.params.number), body);
  });
  const codexLogin = options.codexLogin ?? new CodexLogin();
  app.get('/api/codex/login', async () => codexLogin.status());
  app.post('/api/codex/login', async (req) => {
    z.object({}).strict().parse(req.body);
    return codexLogin.start();
  });
  app.post('/api/codex/login/cancel', async (req) => {
    z.object({}).strict().parse(req.body);
    codexLogin.cancel();
    return codexLogin.status();
  });
  app.post('/api/codex/api-key', async (req) => {
    const { key } = z
      .object({ key: z.string().trim().min(20).max(512).regex(/^\S+$/) })
      .strict()
      .parse(req.body);
    return codexLogin.apiKey(key);
  });
  app.put<{ Params: { id: string } }>('/api/repositories/:id/github-user', async (req) => {
    const githubUser = githubLoginInput(req.body);
    const repo = store.repository(req.params.id);
    if (!repo) throw new AppError(t('Repository not found.'), 404);
    if (githubUser) await loggedIn(githubUser);
    const { githubUser: _previous, ...rest } = repo;
    const updated: Repository = githubUser ? { ...rest, githubUser } : rest;
    store.saveRepository(updated);
    return { ...updated, defaultLocalBase: await defaultLocalBase(updated) };
  });
  app.get<{ Params: { id: string } }>('/api/repositories/:id/branches', async (req) => {
    const repo = store.repository(req.params.id);
    if (!repo) throw new AppError(t('Repository not found.'), 404);
    return localBranches(repo);
  });
  app.get<{ Params: { id: string } }>('/api/repositories/:id/pulls', async (req) => {
    const repo = store.repository(req.params.id);
    if (!repo) throw new AppError(t('Repository not found.'), 404);
    const current = await refreshLocalRepository(repo);
    if (current.slug.startsWith('local/')) return [];
    return github.listPRs(current.slug);
  });
  app.get('/api/sessions', async () =>
    store.sessions().map((s) => {
      ensureReviewWorkflow(s, store.drafts(s.id));
      return sessionListItem(s);
    }),
  );
  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const { title } = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body);
    const s = session(req.params.id);
    s.title = title;
    store.saveSession(s);
    return { id: s.id, title };
  });
  const sessionInput = z.object({
    title: z.string().min(1).max(200),
    repositories: z
      .array(
        z.object({
          repoId: z.string(),
          prNumber: z.number().int().positive().nullable(),
          localBase: z.string().trim().min(1).max(200).optional(),
        }),
      )
      .min(1)
      .max(8),
  });
  app.post('/api/sessions', async (req) => {
    const input = sessionInput.parse(req.body);
    if (!input.repositories.some((r) => r.prNumber !== null || r.localBase))
      throw new AppError(t('Choose a PR or local changes.'));
    if (new Set(input.repositories.map((r) => r.repoId)).size !== input.repositories.length)
      throw new AppError(t('A repository can take part in a session only once.'));
    const snapshots: Snapshot[] = [];
    for (const item of input.repositories) {
      const saved = store.repository(item.repoId);
      if (!saved) throw new AppError(t('Repository not found.'), 404);
      const repo = await refreshLocalRepository(saved);
      if (item.prNumber !== null && repo.slug.startsWith('local/'))
        throw new AppError(
          t(
            'No GitHub remote was found for this repository. Choose a local review or connect it as context.',
          ),
        );
      if (fixes.isRepositoryRunning(repo.id))
        throw new AppError(
          t('Codex is working with this folder right now. Wait until it finishes.'),
          409,
        );
      if (item.localBase && item.prNumber !== null)
        throw new AppError(t('Choose one review mode for the repository.'));
      snapshots.push(
        item.localBase
          ? await createLocalSnapshot(repo, item.localBase, join(dataDir, 'snapshots'))
          : await createSnapshot(repo, item.prNumber, join(dataDir, 'snapshots'), github),
      );
    }
    const s: ReviewSession = {
      id: randomUUID(),
      title: input.title,
      createdAt: new Date().toISOString(),
      snapshots,
      contracts: await extractAllContracts(snapshots),
      contractsVersion: CONTRACTS_VERSION,
      run: null,
    };
    store.saveSession(s);
    return s;
  });
  const upgrades = new Map<string, Promise<ReviewSession>>();
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) =>
    exclusive(req.params.id, async () => {
      const current = session(req.params.id);
      if (fixes.isRunning(current.id)) throw new AppError(t('Stop the Codex fixes first.'), 409);
      if (analysis.isRunning(current.id) || current.run?.state === 'running')
        throw new AppError(t('Stop the analysis of this review first.'), 409);
      if (awaitingGitHub(store.drafts(current.id)))
        throw new AppError(t('Finish verifying the review submission with GitHub first.'), 409);
      const retained = new Set(
        store
          .sessions()
          .filter((value) => value.id !== current.id)
          .flatMap(sessionSnapshots)
          .map((snapshot) => snapshot.id),
      );
      const ids = new Set(sessionSnapshots(current).map((snapshot) => snapshot.id));
      store.deleteSession(current.id);
      const warnings: string[] = [];
      for (const id of ids)
        if (!retained.has(id) && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) {
          try {
            await rm(join(dataDir, 'snapshots', id), { recursive: true, force: true });
          } catch {
            warnings.push(t('Some local code snapshots could not be deleted.'));
          }
        }
      try {
        await rm(join(dataDir, 'fix-homes', current.id), { recursive: true, force: true });
      } catch {
        warnings.push(t('Some local Codex context could not be deleted.'));
      }
      const homes = new Set(
        [current.run, ...(current.history ?? []).map((revision) => revision.run)]
          .flatMap((run) => [run?.conversation?.home, run?.checkpoint?.pending?.home])
          .filter((home): home is string => !!home),
      );
      for (const home of homes) {
        if (!resolve(home).startsWith(join(tmpdir(), 'review-codex-'))) continue;
        try {
          await rm(home, { recursive: true, force: true });
        } catch {
          warnings.push(t('Some local Codex context could not be deleted.'));
        }
      }
      return { ok: true, warnings: [...new Set(warnings)] };
    }),
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    let old = session(req.params.id);
    if (sessionSnapshots(old).some((s) => !s.contentHash || !s.baseContentHash)) {
      await Promise.all(sessionSnapshots(old).map((s) => snapshotContent(s).catch(() => s)));
      const hashes = new Map(
        sessionSnapshots(old).map((s) => [
          s.id,
          { contentHash: s.contentHash, baseContentHash: s.baseContentHash },
        ]),
      );
      old = session(old.id);
      for (const snap of sessionSnapshots(old)) Object.assign(snap, hashes.get(snap.id));
      store.saveSession(old);
    }
    if (restoreDiscussionOnlyReview(old)) store.saveSession(old);
    if (old.contractsVersion !== CONTRACTS_VERSION) {
      old.contracts = await extractAllContracts(old.snapshots);
      old.contractsVersion = CONTRACTS_VERSION;
      if (old.run?.state !== 'running') store.saveSession(old);
    }
    analysis.restoreCached(old);
    if (
      !old.run ||
      old.run.state === 'running' ||
      !old.run.result.indexes.some((i) => i.version !== INDEX_VERSION)
    )
      return old;
    const pending = upgrades.get(old.id);
    if (pending) return pending;
    const update = (async () => {
      const indexes = await Promise.all(
        old.run!.result.indexes.map(async (i) => {
          if (i.version === INDEX_VERSION) return i;
          const snap = old.snapshots.find((s) => s.repoId === i.repoId);
          if (!snap) return i;
          try {
            return await indexSnapshot(snap, i.side);
          } catch {
            return i;
          } // Missing archived sources must not prevent opening a saved review.
        }),
      );
      const current = session(old.id);
      if (
        current.run?.id !== old.run!.id ||
        current.run.state === 'running' ||
        current.snapshots.map((s) => s.id).join() !== old.snapshots.map((s) => s.id).join()
      )
        return current;
      current.run.result.indexes = indexes;
      store.saveSession(current);
      if (current.run.state === 'complete')
        store.saveAnalysisResult(current.run.fingerprint, current.run.result, current.snapshots);
      return current;
    })().finally(() => upgrades.delete(old.id));
    upgrades.set(old.id, update);
    return update;
  });
  async function refreshSession(id: string, body: unknown = {}, workingRepoId?: string) {
    const old = session(id);
    restoreDiscussionOnlyReview(old);
    if (restoreReviewBranch(old)) store.saveSession(old);
    if (fixes.isRunning(old.id)) throw new AppError(t('Wait until the Codex fixes finish.'), 409);
    if (old.run?.state === 'running') throw new AppError(t('Cancel the analysis first.'), 409);
    const drafts = store.drafts(old.id);
    if (awaitingGitHub(drafts)) throw new AppError(t('Verify the sent reviews first.'), 409);
    const { localBases, analyze } = z
      .object({
        localBases: z.record(z.string(), z.string().trim().min(1).max(200)).optional(),
        analyze: z.boolean().optional(),
      })
      .parse(body ?? {});
    for (const repoId of Object.keys(localBases ?? {}))
      if (!old.snapshots.some((snapshot) => snapshot.repoId === repoId && snapshot.local))
        throw new AppError(t('A base branch applies only to a local review.'), 400);
    const previous = old.snapshots;
    await Promise.all(previous.map(snapshotContent));
    const snapshots: Snapshot[] = [];
    for (const item of previous) {
      const repo = store.repository(item.repoId);
      if (!repo) throw new AppError(t('Repository not found.'), 404);
      if (fixes.isRepositoryRunning(repo.id) && repo.id !== workingRepoId)
        throw new AppError(
          t('Codex is working with this folder right now. Wait until it finishes.'),
          409,
        );
      // Check cheap remote metadata before fetching/materializing another pair of trees.
      const discovered =
        item.local?.branchName && !item.slug.startsWith('local/') && github.findPullRequest
          ? await github.findPullRequest(item.slug, item.local.branchName).catch(() => undefined)
          : undefined;
      const pr = item.pr ? await github.pull(item.slug, item.pr.number) : (discovered ?? null);
      if (pr && item.local) {
        snapshots.push(await createSnapshot(repo, pr.number, join(dataDir, 'snapshots'), github));
        continue;
      }
      const localBase = localBases?.[item.repoId] ?? item.local?.baseRef;
      if (item.local) await refreshRemoteBase(repo, localBase!);
      if (pr && (workingRepoId === item.repoId || item.working)) {
        if (
          workingRepoId === item.repoId &&
          !item.working &&
          store.fixChat(old.id)?.fingerprint !== (await workingSources(repo)).fingerprint
        )
          throw new AppError(
            t('The working folder changed. Refresh the review before publishing.'),
            409,
          );
        const local = await createLocalSnapshot(
          repo,
          pr.baseRefName,
          join(dataDir, 'snapshots'),
          false,
        );
        const remote =
          pr.headRefOid === item.pr?.headRefOid && !item.working
            ? item
            : await createSnapshot(repo, pr.number, join(dataDir, 'snapshots'), github);
        if (sourceIdentity(local) === sourceIdentity(remote))
          snapshots.push({ ...remote, pr, reviewLineage: item.reviewLineage });
        else {
          const { local: working, ...source } = local;
          snapshots.push({ ...source, working, pr, reviewLineage: item.reviewLineage });
        }
        continue;
      }
      const branchMatches =
        !item.local?.branchName ||
        (
          await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
        ).trim() === item.local.branchName;
      const unchanged = item.local
        ? branchMatches &&
          localBase === item.local.baseRef &&
          (await workingSources(repo)).fingerprint === item.local.fingerprint &&
          (
            await git(repo.path, [
              'rev-parse',
              '--verify',
              '--end-of-options',
              `${localBase}^{commit}`,
            ])
          ).trim() === item.local.baseCommit
        : pr
          ? pr.headRefOid === item.headSha && pr.baseRefOid === item.baseSha
          : (await git(repo.path, ['rev-parse', 'HEAD'])).trim() === item.headSha;
      if (unchanged) {
        snapshots.push(pr ? { ...item, pr } : item);
        continue;
      }
      snapshots.push(
        item.local
          ? await createLocalSnapshot(
              repo,
              localBase!,
              join(dataDir, 'snapshots'),
              false,
              item.local,
            )
          : await createSnapshot(repo, item.pr?.number ?? null, join(dataDir, 'snapshots'), github),
      );
    }
    const workflow = ensureReviewWorkflow(old);
    const explicitBaseChange = snapshots.some(
      (s) =>
        s.local && s.local.baseRef !== previous.find((p) => p.repoId === s.repoId)?.local?.baseRef,
    );
    if (explicitBaseChange) {
      for (const initial of workflow.initial.snapshots)
        if (!workflow.versions.some((s) => s.id === initial.id)) workflow.versions.push(initial);
      workflow.initial = {
        at: new Date().toISOString(),
        snapshots: snapshots.map((s) => ({ ...s })),
      };
    }
    for (const snap of snapshots) {
      const prior = previous.find((p) => p.repoId === snap.repoId);
      if (prior?.local?.baseRef !== snap.local?.baseRef) continue;
      snap.reviewLineage = prior?.reviewLineage;
      const initial = workflow.initial.snapshots.find((p) => p.repoId === snap.repoId);
      if (initial && initial.mergeBase !== snap.mergeBase) {
        snap.files = await snapshotDiff(initial, snap, 'base');
        snap.baseDir = initial.baseDir;
        snap.baseFiles = initial.baseFiles;
        snap.mergeBase = initial.mergeBase;
        snap.baseContentHash = initial.baseContentHash;
      }
    }
    const { comments: discussion, warnings: gaps } = await discussions.refresh(old.id);
    const copyThreadState = () => {
      const current = session(old.id);
      old.threadDiscussion = current.threadDiscussion;
      old.discussionRevision = current.discussionRevision;
    };
    copyThreadState();
    const changed = snapshots.some((snap) => {
      const prior = previous.find((s) => s.repoId === snap.repoId);
      return (
        !prior ||
        sourceIdentity(prior) !== sourceIdentity(snap) ||
        sourceIdentity(prior, 'base') !== sourceIdentity(snap, 'base') ||
        prior.local?.baseRef !== snap.local?.baseRef
      );
    });
    old.refreshWarnings = gaps;
    if (!changed) {
      // Discussion and PR metadata are synchronized without rebuilding or invalidating
      // any reviewed code, draft, analysis checkpoint or comparison baseline.
      old.snapshots = previous.map((prior) => {
        const latest = snapshots.find((item) => item.repoId === prior.repoId)!;
        return { ...latest, id: prior.id, reviewLineage: prior.reviewLineage };
      });
      for (const draft of drafts) {
        const snap = old.snapshots.find((s) => s.id === draft.snapshotId);
        if (snap && draft.state === 'draft' && draft.headSha !== snap.headSha)
          store.saveDraft({ ...draft, headSha: snap.headSha });
      }
      store.saveSession(old);
      if (analyze && workingRepoId && !old.run && old.update?.changes.some((c) => c.files.length))
        return analysis.start(old);
      return old;
    }
    // Each repository may act as its own account; comments by any of them are ours.
    const logins = discussion.length
      ? await Promise.all(
          [...new Set(snapshots.filter((snap) => snap.pr).map((snap) => snap.slug))].map((slug) =>
            github
              .user(slug)
              .then((user) => user.login)
              .catch(() => undefined),
          ),
        )
      : [];
    const own = ownReviewDiscussion(
      drafts,
      sessionSnapshots(old),
      logins.filter((login): login is string => !!login),
    );
    const newDiscussion = discussion.filter((comment) => {
      if (own(comment)) return false;
      const previousComment = old.discussion?.find(
        (item) => item.id === comment.id && item.repoId === comment.repoId,
      );
      return previousComment
        ? previousComment.body !== comment.body
        : !old.run?.finishedAt ||
            comment.updatedAt > (old.run.cacheRestored ? old.createdAt : old.run.finishedAt);
    });
    archiveReview(old, drafts);
    const baseline = old.history?.at(-1);
    if (baseline) {
      const changes = [];
      for (const snap of snapshots) {
        const prior = baseline.snapshots.find((s) => s.repoId === snap.repoId);
        const repo = store.repository(snap.repoId);
        if (!prior || !repo) continue;
        let files: Snapshot['files'] = [];
        const scopeChanged =
          prior.mergeBase !== snap.mergeBase || prior.local?.baseRef !== snap.local?.baseRef;
        if (scopeChanged) files = snap.files;
        else if (prior.headSha !== snap.headSha) {
          try {
            files = await changedFiles(
              snap.local ? { ...repo, path: snap.local.gitDir } : repo,
              prior.headSha,
              snap.headSha,
            );
          } catch (e) {
            try {
              files = await snapshotDiff(prior, snap);
            } catch {
              gaps.push(
                t('The diff since the review ({0}) is unavailable: {1}', snap.repoName, String(e)),
              );
            }
          }
        }
        changes.push({ repoId: snap.repoId, fromSha: prior.headSha, toSha: snap.headSha, files });
      }
      old.update = {
        scopeChanged: snapshots.some((snap) => {
          const prior = previous.find((s) => s.repoId === snap.repoId);
          return (
            prior &&
            (prior.mergeBase !== snap.mergeBase || prior.local?.baseRef !== snap.local?.baseRef)
          );
        }),
        id: randomUUID(),
        at: new Date().toISOString(),
        previousReviewId: baseline.id,
        changes,
        discussion: [
          ...(old.update?.previousReviewId === baseline.id ? old.update.discussion : []),
          ...newDiscussion,
        ].filter(
          (c, i, all) =>
            all.findLastIndex((other) => other.id === c.id && other.repoId === c.repoId) === i,
        ),
        gaps,
      };
    }
    if (!baseline && workingRepoId) {
      const changes = [];
      for (const snap of snapshots) {
        const prior = previous.find((s) => s.repoId === snap.repoId);
        if (prior)
          changes.push({
            repoId: snap.repoId,
            fromSha: prior.headSha,
            toSha: snap.headSha,
            files: await snapshotDiff(prior, snap),
          });
      }
      ensureReviewWorkflow(old).technicalDelta = {
        snapshotIds: snapshots.map((s) => s.id),
        changes,
      };
    }
    if (!gaps.length && github.discussion) old.discussion = discussion;
    old.snapshots = changed ? snapshots : previous;
    old.contracts = await extractAllContracts(old.snapshots);
    old.contractsVersion = CONTRACTS_VERSION;
    old.run = null;
    copyThreadState();
    const carriedDrafts: ReviewDraft[] = [];
    for (const snap of old.snapshots.filter((s) => s.pr || s.local)) {
      const prior = previous.find((s) => s.repoId === snap.repoId);
      const draft = drafts.find((d) => d.snapshotId === prior?.id);
      if (!prior || !draft || draft.state !== 'draft') continue;
      const comments = await Promise.all(
        draft.comments.map(async (c) => {
          if (!c.evidence || c.outdated) return c;
          const mapped = await remapEvidence(
            prior,
            snap,
            c.evidence,
            old.update?.changes.find((c) => c.repoId === snap.repoId)?.files,
          );
          return {
            ...c,
            origin: c.origin ?? { snapshotId: prior.id, evidence: c.evidence },
            evidence: mapped ?? c.origin?.evidence ?? c.evidence,
            outdated: !mapped,
            selected: mapped ? c.selected : false,
          };
        }),
      );
      carriedDrafts.push({
        ...draft,
        snapshotId: snap.id,
        headSha: snap.headSha,
        attempt: null,
        submission: null,
        comments,
      });
    }
    store.saveReviewUpdate(old, carriedDrafts);
    if (analyze) return analysis.start(old);
    return old;
  }
  app.post<{ Params: { id: string } }>('/api/sessions/:id/refresh', async (req) =>
    exclusive(req.params.id, () => refreshSession(req.params.id, req.body)),
  );
  app.get<{ Params: { id: string; previewId: string } }>(
    '/api/sessions/:id/pull-request/:previewId',
    (req) => {
      const current = session(req.params.id),
        preview = store.pullRequestPreview(req.params.previewId);
      if (!preview || preview.sessionId !== current.id)
        throw new AppError(t('The PR preview is unavailable.'), 404);
      return { session: current, preview };
    },
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/pull-request/prepare', (req) =>
    exclusive(req.params.id, async () => {
      const { repoId } = z.object({ repoId: z.string() }).parse(req.body);
      const current = session(req.params.id);
      if (fixes.isRunning(current.id) || current.run?.state === 'running')
        throw new AppError(t('Wait until the current work finishes.'), 409);
      return publications.prepare(current.id, repoId);
    }),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/pull-request/create', (req) =>
    exclusive(req.params.id, async () => {
      const { previewId, title, body } = z
        .object({
          previewId: z.string(),
          title: z.string().trim().min(1).max(256),
          body: z.string().max(60000),
        })
        .parse(req.body);
      const current = session(req.params.id);
      if (fixes.isRunning(current.id) || current.run?.state === 'running')
        throw new AppError(t('Wait until the current work finishes.'), 409);
      return publications.create(current.id, previewId, title, body);
    }),
  );
  const remoteSync = new Map<string, Promise<ReviewSession>>();
  app.get<{ Params: { id: string } }>('/api/sessions/:id/remote-state', async (req) => {
    const id = req.params.id;
    if (remoteSync.has(id)) return remoteSync.get(id)!;
    const pending = (async () => {
      const discoveryWarnings: string[] = [];
      let before = session(id);
      if (!fixes.isRunning(id) && restoreReviewBranch(before)) {
        store.saveSession(before);
        before = session(id);
      }
      if (!fixes.isRunning(id) && before.run?.state !== 'running' && github.findPullRequest) {
        for (const s of before.snapshots.filter(
          (s) => s.local?.branchName && !s.slug.startsWith('local/'),
        )) {
          const pr = await github.findPullRequest(s.slug, s.local!.branchName!).catch((error) => {
            discoveryWarnings.push(errorMessage(error));
            return undefined;
          });
          if (pr) {
            try {
              await refreshSession(id, { analyze: false });
            } catch (error) {
              discoveryWarnings.push(errorMessage(error));
            }
            before = session(id);
            break;
          }
        }
      }
      const values = await Promise.allSettled(
        before.snapshots
          .filter((s) => s.pr)
          .map(async (snapshot) => ({
            repoId: snapshot.repoId,
            number: snapshot.pr!.number,
            at: new Date().toISOString(),
            ...(github.remoteState
              ? await github.remoteState(snapshot.slug, snapshot.pr!.number)
              : {
                  state: (await github.pull(snapshot.slug, snapshot.pr!.number)).state ?? 'open',
                  headSha: snapshot.headSha,
                  decision: 'unknown' as const,
                }),
          })),
      );
      await discussions.refresh(id);
      const current = session(id),
        workflow = ensureReviewWorkflow(current);
      const states = new Map((workflow.remote ?? []).map((r) => [r.repoId, r]));
      const warnings: string[] = [...discoveryWarnings];
      for (const value of values)
        if (value.status === 'fulfilled') states.set(value.value.repoId, value.value);
        else warnings.push(errorMessage(value.reason));
      workflow.remote = [...states.values()];
      workflow.remoteWarnings = warnings;
      store.saveSession(current);
      return current;
    })().finally(() => remoteSync.delete(id));
    remoteSync.set(id, pending);
    return pending;
  });
  // Every model job waits for Codex fixes to finish and runs one at a time per session.
  const analysisJobs: Record<string, (s: ReviewSession, body: unknown) => Promise<unknown>> = {
    analyze: async (current) => {
      if (restoreDiscussionOnlyReview(current)) store.saveSession(current);
      return analysis.start(current);
    },
    'resume-analysis': async (current) => analysis.resume(current),
    // With a root or a query line, only that entry method or that query method is analyzed.
    'scenario-analysis': async (current, body) =>
      analysis.startScenarios(
        current,
        z
          .object({ root: z.string().min(1).max(2000).optional() })
          .strict()
          .parse(body ?? {}).root,
      ),
    'sql-analysis': async (current, body) =>
      analysis.startSql(
        current,
        z
          .object({
            method: z
              .object({
                repoId: z.string(),
                side: z.enum(['head', 'base']),
                path: z.string().min(1).max(2000),
                line: z.number().int().positive(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .parse(body ?? {}).method,
      ),
    'test-analysis': async (current) => analysis.startTests(current),
  };
  for (const [route, start] of Object.entries(analysisJobs))
    app.post<{ Params: { id: string } }>(`/api/sessions/:id/${route}`, async (req) =>
      exclusive(req.params.id, async () => {
        if (fixes.isRunning(req.params.id))
          throw new AppError(t('Wait until the Codex fixes finish.'), 409);
        return start(session(req.params.id), req.body);
      }),
    );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/analysis-message', async (req) => {
    const body = z.object({ text: z.string().trim().min(1).max(12000) }).parse(req.body);
    return analysis.addMessage(session(req.params.id), body.text);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (req) => {
    analysis.cancel(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/sessions/:id/events',
    async (req, reply) => {
      const s = session(req.params.id);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (e: unknown) => {
        if (!reply.raw.destroyed)
          reply.raw.write(`id: ${(e as { seq: number }).seq}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const after = Number(req.query.after ?? req.headers['last-event-id'] ?? 0);
      for (const event of s.run?.events ?? []) if (event.seq > after) send(event);
      const unsubscribe = analysis.subscribe(s.id, send);
      const timer = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
      reply.raw.on('close', () => {
        unsubscribe();
        clearInterval(timer);
      });
    },
  );
  const methodViewTarget = (sessionId: string, value: unknown) => {
    const query = z
      .object({ snapshotId: z.string(), path: z.string(), side: z.enum(['head', 'base']) })
      .parse(value);
    return { ...query, snapshot: anySnapshot(session(sessionId), query.snapshotId) };
  };
  app.get<{ Params: { id: string } }>('/api/sessions/:id/viewed-methods', async (req) => {
    const target = methodViewTarget(req.params.id, req.query);
    return viewedMethods.list(req.params.id, target.snapshot, target.path, target.side);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/navigation-index', async (req) => {
    const query = z
      .object({ snapshotId: z.string(), side: z.enum(['head', 'base']) })
      .parse(req.query);
    const snapshot = anySnapshot(session(req.params.id), query.snapshotId);
    const { index } = await storedIndex(store, snapshot, query.side);
    // Local syntax metadata only: navigation never starts a model analysis.
    return packIndex({
      ...index,
      methods: index.methods.map(({ owner, name, signature, evidence, callSites }) => ({
        owner,
        name,
        signature,
        evidence,
        callSites,
        annotations: [],
        calls: [],
      })),
    });
  });
  app.put<{ Params: { id: string } }>('/api/sessions/:id/viewed-methods', async (req) => {
    const target = methodViewTarget(req.params.id, req.body);
    const body = z
      .object({ line: z.number().int().positive(), viewed: z.boolean() })
      .parse(req.body);
    return viewedMethods.set(
      req.params.id,
      target.snapshot,
      target.path,
      target.side,
      body.line,
      body.viewed,
    );
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/viewed-files', async (req) => {
    const current = session(req.params.id),
      query = z.object({ snapshotIds: z.string().optional() }).parse(req.query);
    const ids = query.snapshotIds?.split(',') ?? current.snapshots.map((snapshot) => snapshot.id);
    const selected = [...new Set(ids)].map((id) => anySnapshot(current, id));
    return viewedFiles.list(current.id, selected);
  });
  app.put<{ Params: { id: string } }>('/api/sessions/:id/viewed-files', async (req) => {
    const body = z
      .object({ snapshotId: z.string(), path: z.string(), viewed: z.boolean() })
      .parse(req.body);
    const current = session(req.params.id);
    return viewedFiles.set(
      current.id,
      anySnapshot(current, body.snapshotId),
      body.path,
      body.viewed,
    );
  });
  app.get<{
    Params: { id: string };
    Querystring: { repoId: string; side: string; path: string; snapshotId?: string };
  }>('/api/sessions/:id/source', async (req) => {
    const q = z
      .object({
        repoId: z.string(),
        side: z.enum(['base', 'head']),
        path: z.string(),
        snapshotId: z.string().optional(),
      })
      .parse(req.query);
    const s = session(req.params.id),
      snap = q.snapshotId
        ? anySnapshot(s, q.snapshotId)
        : s.snapshots.find((snap) => snap.repoId === q.repoId);
    if (!snap || snap.repoId !== q.repoId) throw new AppError(t('Repository not found.'), 404);
    return { text: await readSource(snap, q) };
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/code-comparison', async (req) => {
    const query = z
      .object({ revisionId: z.string(), repoId: z.string(), path: z.string() })
      .parse(req.query);
    return codeComparison(
      store,
      session(req.params.id),
      query.revisionId,
      query.repoId,
      query.path,
    );
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/review-comparison', async (req) => {
    const { from } = z
      .object({ from: z.string(), to: z.literal('current').optional() })
      .parse(req.query);
    return comparisons.read(session(req.params.id), from);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/database-schema', async (req) => {
    const { snapshotId } = z.object({ snapshotId: z.string() }).parse(req.query);
    return databaseSchema(anySnapshot(session(req.params.id), snapshotId));
  });
  const queryTarget = async (sessionId: string, query: unknown) => {
    const q = z
      .object({
        repoId: z.string(),
        snapshotId: z.string(),
        side: z.enum(['head', 'base']),
        path: z.string(),
        line: z.coerce.number().int().positive(),
      })
      .parse(query);
    const snapshot = anySnapshot(session(sessionId), q.snapshotId);
    if (snapshot.repoId !== q.repoId) throw new AppError(t('Snapshot not found.'), 404);
    const { index } = await storedIndex(store, snapshot, q.side);
    const methods = index.methods.filter(
      (method) =>
        method.evidence.path === q.path &&
        method.evidence.startLine <= q.line &&
        method.evidence.endLine >= q.line,
    );
    if (methods.length !== 1)
      throw new AppError(t('The query method could not be identified unambiguously.'), 422);
    const method = methods[0];
    const key = JSON.stringify([sessionId, snapshot.id, q.side, q.path, method.evidence.startLine]);
    return { q, snapshot, method, key };
  };
  app.get<{ Params: { id: string } }>('/api/sessions/:id/sql-preview', async (req) => {
    const target = await queryTarget(req.params.id, req.query);
    const captured = store.sqlCapture(target.key);
    if (captured) return captured.preview;
    const current = session(req.params.id);
    const snapshotId = target.snapshot.reviewSnapshotId ?? target.snapshot.id;
    const result = current.snapshots.some((snapshot) => snapshot.id === snapshotId)
      ? current.run?.result
      : current.history?.find((revision) =>
          revision.snapshots.some((snapshot) => snapshot.id === snapshotId),
        )?.run.result;
    return sqlPreview(target.snapshot, target.method, result);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/sql-capture', async (req) =>
    exclusive(req.params.id, async () => {
      const body = z
        .object({
          snapshotId: z.string(),
          repoId: z.string(),
          side: z.literal('head'),
          path: z.string(),
          line: z.number().int().positive(),
          headSha: z.string(),
          sql: z.string().min(1).max(100000),
          framework: z.enum(['jooq', 'hibernate', 'jdbc']),
          dialect: z.string().min(1).max(100),
        })
        .parse(req.body);
      const target = await queryTarget(req.params.id, body);
      if (target.snapshot.headSha !== body.headSha)
        throw new AppError(t('The SQL belongs to another head SHA. Import rejected.'), 409);
      const preview = {
        evidence: target.method.evidence,
        snapshotId: target.snapshot.id,
        headSha: target.snapshot.headSha,
        method: target.method.name,
        origin: 'captured' as const,
        framework: body.framework,
        dialect: body.dialect,
        sql: body.sql,
        parameters: [],
        unknowns: [
          t(
            'The SQL was imported from the provided application trace. Its origin is not verified automatically.',
          ),
        ],
      };
      store.saveSqlCapture({ id: target.key, sessionId: req.params.id, preview });
      return preview;
    }),
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id/discussion', async (req) => {
    session(req.params.id);
    return discussions.refresh(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/discussion/replies', async (req) =>
    exclusive(req.params.id, async () => {
      const body = z
        .object({
          repoId: z.string(),
          rootId: z.string(),
          body: z.string().trim().min(1).max(20_000),
        })
        .parse(req.body);
      return discussions.reply(req.params.id, body.repoId, body.rootId, body.body);
    }),
  );
  app.put<{ Params: { id: string } }>('/api/sessions/:id/discussion/reactions', async (req) =>
    exclusive(req.params.id, async () => {
      const body = z
        .object({
          repoId: z.string(),
          commentId: z.string(),
          content: z.enum(REACTION_CONTENTS),
          active: z.boolean(),
        })
        .parse(req.body);
      return discussions.react(
        req.params.id,
        body.repoId,
        body.commentId,
        body.content,
        body.active,
      );
    }),
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id/drafts', async (req) => {
    const s = session(req.params.id);
    return s.snapshots.filter((s) => s.pr || s.local).map((snap) => review.get(s, snap));
  });
  app.put<{ Params: { id: string; snapshotId: string } }>(
    '/api/sessions/:id/drafts/:snapshotId',
    async (req) =>
      exclusive(req.params.id, async () => {
        const s = session(req.params.id);
        return review.save(s, snapshot(s, req.params.snapshotId), req.body);
      }),
  );
  app.post<{ Params: { id: string; snapshotId: string } }>(
    '/api/sessions/:id/drafts/:snapshotId/continue',
    async (req) =>
      exclusive(req.params.id, async () => {
        const s = session(req.params.id);
        return review.continue(s, snapshot(s, req.params.snapshotId));
      }),
  );
  app.post<{ Params: { id: string; snapshotId: string; commentId: string } }>(
    '/api/sessions/:id/drafts/:snapshotId/comments/:commentId/accept-fix',
    async (req) => {
      const s = session(req.params.id);
      return review.acceptFix(s, snapshot(s, req.params.snapshotId), req.params.commentId);
    },
  );
  app.post<{ Params: { id: string; snapshotId: string } }>(
    '/api/sessions/:id/drafts/:snapshotId/submit',
    async (req) =>
      exclusive(req.params.id, async () => {
        const s = session(req.params.id);
        const body = z.object({ round: z.string().optional() }).parse(req.body ?? {});
        return review.publish(s, snapshot(s, req.params.snapshotId), body.round);
      }),
  );
  app.post<{ Params: { id: string; snapshotId: string } }>(
    '/api/sessions/:id/drafts/:snapshotId/reconcile',
    async (req) => {
      const s = session(req.params.id);
      return review.reconcile(s, snapshot(s, req.params.snapshotId));
    },
  );
  const dist = resolve(options.webDir ?? 'dist');
  if (existsSync(dist)) {
    app.register(staticPlugin, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: t('Route not found.') })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onReady', async () => {
    fixes.recoverUpdates();
  });
  app.addHook('onClose', async () => {
    githubLogin.cancel();
    await fixes.stopAll();
    await analysis.stopAll();
    await Promise.allSettled(remoteSync.values());
    terminals.stopAll();
    await Promise.allSettled(upgrades.values());
    store.close();
  });
  return { app, store, analysis, review, fixes };
}
