import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { GitHub, type GitHubGateway } from './github.js';
import { indexSnapshot, INDEX_VERSION } from './indexer.js';
import { AnalysisManager } from './analysis.js';
import { CodexProvider, type AnalysisProvider } from './provider.js';
import { ReviewManager } from './review.js';
import { pickDirectory } from './directory-picker.js';
import { connectRepository, createSnapshot, readSource, changedFiles } from './repository.js';
import { archiveReview } from './revisions.js';
import { sqlPreview } from './sql-preview.js';
import { databaseSchema } from './database-schema.js';
import { REACTION_CONTENTS } from '../shared/reactions.js';
import { codeComparison } from './code-comparison.js';
import { Discussions } from './discussion.js';
import { ViewedMethods } from './viewed-methods.js';
import { ViewedFiles } from './viewed-files.js';
import { AppError, command, git } from './process.js';
import type { ReviewSession, Snapshot, ReviewDiscussion } from '../shared/model.js';

export function createApp(
  options: {
    dataDir?: string;
    github?: GitHubGateway;
    provider?: AnalysisProvider;
    port?: number;
    demo?: boolean;
    chooseDirectory?: () => Promise<string | null>;
  } = {},
) {
  const dataDir = resolve(options.dataDir ?? process.env.REVIEW_DATA_DIR ?? '.review');
  const store = new Store(join(dataDir, 'review.sqlite'));
  store.recover();
  const github = options.github ?? new GitHub();
  const analysis = new AnalysisManager(store, options.provider ?? new CodexProvider());
  const review = new ReviewManager(store, github);
  const viewedFiles = new ViewedFiles(store);
  const viewedMethods = new ViewedMethods(store);
  const discussions = new Discussions(store, github);
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  const port = options.port ?? Number(process.env.REVIEW_PORT ?? 4318);
  const mutations = new Set<string>();
  const exclusive = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    if (mutations.has(id)) throw new AppError('Операция с этой сессией уже выполняется.', 409);
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
      return reply.code(403).send({ error: 'Разрешён только локальный доступ.' });
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
      return reply.code(403).send({ error: 'Недопустимый Origin.' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Межсайтовые запросы запрещены.' });
    if (
      ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) &&
      !req.headers['content-type']?.startsWith('application/json')
    )
      return reply.code(415).send({ error: 'Нужен application/json.' });
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    reply
      .code(error instanceof AppError ? error.status : 500)
      .send({ error: error instanceof Error ? error.message : 'Ошибка приложения' });
  });
  const session = (id: string) => {
    const s = store.session(id);
    if (!s) throw new AppError('Сессия не найдена.', 404);
    return s;
  };
  const snapshot = (s: ReviewSession, id: string) => {
    const item = s.snapshots.find((x) => x.id === id);
    if (!item) throw new AppError('Снимок не найден.', 404);
    return item;
  };
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/status', async () => {
    let login: string | null = null,
      githubError: string | null = null,
      codex: string | null = null;
    try {
      login = (await github.user()).login;
    } catch (e) {
      githubError = e instanceof Error ? e.message : String(e);
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
      demo: options.demo ?? false,
      provider: options.provider?.id ?? 'Codex SDK',
      model: process.env.REVIEW_CODEX_MODEL ?? 'default',
      dataDir,
    };
  });
  app.get('/api/repositories', async () => store.repositories());
  let directoryPickerOpen = false;
  app.post('/api/repositories/pick-directory', async (req) => {
    z.object({}).strict().parse(req.body);
    if (directoryPickerOpen) throw new AppError('Окно выбора папки уже открыто.', 409);
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
    if (old) return old;
    store.saveRepository(repo);
    return repo;
  });
  app.get<{ Params: { id: string } }>('/api/repositories/:id/pulls', async (req) => {
    const repo = store.repository(req.params.id);
    if (!repo) throw new AppError('Репозиторий не найден.', 404);
    return github.listPRs(repo.slug);
  });
  app.get('/api/sessions', async () =>
    store.sessions().map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      state: s.run?.state ?? 'ready',
      services: s.snapshots.length,
    })),
  );
  const sessionInput = z.object({
    title: z.string().min(1).max(200),
    repositories: z
      .array(z.object({ repoId: z.string(), prNumber: z.number().int().positive().nullable() }))
      .min(1)
      .max(8),
  });
  app.post('/api/sessions', async (req) => {
    const input = sessionInput.parse(req.body);
    if (!input.repositories.some((r) => r.prNumber !== null))
      throw new AppError('Выберите хотя бы один PR.');
    if (new Set(input.repositories.map((r) => r.repoId)).size !== input.repositories.length)
      throw new AppError('Один репозиторий может участвовать в сессии один раз.');
    const snapshots: Snapshot[] = [];
    for (const item of input.repositories) {
      const repo = store.repository(item.repoId);
      if (!repo) throw new AppError('Репозиторий не найден.', 404);
      snapshots.push(await createSnapshot(repo, item.prNumber, join(dataDir, 'snapshots'), github));
    }
    const s: ReviewSession = {
      id: randomUUID(),
      title: input.title,
      createdAt: new Date().toISOString(),
      snapshots,
      run: null,
    };
    store.saveSession(s);
    return s;
  });
  const upgrades = new Map<string, Promise<ReviewSession>>();
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) =>
    exclusive(req.params.id, async () => {
      const current = session(req.params.id);
      if (analysis.isRunning(current.id) || current.run?.state === 'running')
        throw new AppError('Сначала остановите анализ этого ревью.', 409);
      if (
        store.drafts(current.id).some((draft) => ['submitting', 'uncertain'].includes(draft.state))
      )
        throw new AppError('Сначала завершите сверку отправки ревью с GitHub.', 409);
      const allSnapshots = (value: ReviewSession) => [
        ...value.snapshots,
        ...(value.history ?? []).flatMap((revision) => revision.snapshots),
      ];
      const retained = new Set(
        store
          .sessions()
          .filter((value) => value.id !== current.id)
          .flatMap(allSnapshots)
          .map((snapshot) => snapshot.id),
      );
      const ids = new Set(allSnapshots(current).map((snapshot) => snapshot.id));
      store.deleteSession(current.id);
      const warnings: string[] = [];
      for (const id of ids)
        if (!retained.has(id) && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) {
          try {
            await rm(join(dataDir, 'snapshots', id), { recursive: true, force: true });
          } catch {
            warnings.push('Не удалось удалить часть локальных снимков кода.');
          }
        }
      return { ok: true, warnings: [...new Set(warnings)] };
    }),
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const old = session(req.params.id);
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
        store.saveAnalysisResult(current.run.fingerprint, current.run.result);
      return current;
    })().finally(() => upgrades.delete(old.id));
    upgrades.set(old.id, update);
    return update;
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/refresh', async (req) =>
    exclusive(req.params.id, async () => {
      const old = session(req.params.id);
      if (old.run?.state === 'running') throw new AppError('Сначала отмените анализ.', 409);
      const drafts = store.drafts(old.id);
      if (drafts.some((d) => ['submitting', 'uncertain'].includes(d.state)))
        throw new AppError('Сначала выполните сверку отправленных ревью.', 409);
      const previous = old.snapshots;
      const snapshots: Snapshot[] = [];
      for (const item of previous) {
        const repo = store.repository(item.repoId);
        if (!repo) throw new AppError('Репозиторий не найден.', 404);
        // Check cheap remote metadata before fetching/materializing another pair of trees.
        const pr = item.pr ? await github.pull(item.slug, item.pr.number) : null;
        const unchanged = pr
          ? pr.headRefOid === item.headSha &&
            pr.baseRefOid === item.baseSha &&
            pr.body === item.pr?.body &&
            pr.title === item.pr?.title
          : (await git(repo.path, ['rev-parse', 'HEAD'])).trim() === item.headSha;
        if (unchanged) {
          snapshots.push(item);
          continue;
        }
        snapshots.push(
          await createSnapshot(repo, item.pr?.number ?? null, join(dataDir, 'snapshots'), github),
        );
      }
      const discussion: ReviewDiscussion[] = [];
      const gaps: string[] = [];
      for (const snap of snapshots.filter((s) => s.pr)) {
        try {
          if (github.discussion)
            discussion.push(
              ...(await github.discussion(snap.slug, snap.pr!.number)).map((comment) => ({
                ...comment,
                repoId: snap.repoId,
              })),
            );
        } catch (e) {
          gaps.push(`Ответы GitHub (${snap.repoName}) не загружены: ${String(e)}`);
        }
      }
      const newDiscussion = discussion.filter((comment) => {
        const previousComment = old.discussion?.find(
          (c) => c.id === comment.id && c.repoId === comment.repoId,
        );
        return previousComment
          ? previousComment.body !== comment.body
          : !old.run?.finishedAt ||
              comment.updatedAt > (old.run.cacheRestored ? old.createdAt : old.run.finishedAt);
      });
      const changed = snapshots.some((snap) => {
        const prior = previous.find((s) => s.repoId === snap.repoId);
        return (
          !prior ||
          prior.headSha !== snap.headSha ||
          prior.mergeBase !== snap.mergeBase ||
          prior.pr?.body !== snap.pr?.body ||
          prior.pr?.title !== snap.pr?.title
        );
      });
      old.refreshWarnings = gaps;
      if (!changed && !newDiscussion.length) {
        if (!gaps.length && github.discussion) old.discussion = discussion;
        store.saveSession(old);
        return old;
      }
      archiveReview(old, drafts);
      const baseline = old.history?.at(-1);
      if (baseline) {
        const changes = [];
        for (const snap of snapshots) {
          const prior = baseline.snapshots.find((s) => s.repoId === snap.repoId);
          const repo = store.repository(snap.repoId);
          if (!prior || !repo) continue;
          let files: Snapshot['files'] = [];
          if (prior.headSha !== snap.headSha) {
            try {
              files = await changedFiles(repo, prior.headSha, snap.headSha);
            } catch (e) {
              gaps.push(`Diff после ревью (${snap.repoName}) недоступен: ${String(e)}`);
            }
          }
          changes.push({ repoId: snap.repoId, fromSha: prior.headSha, toSha: snap.headSha, files });
        }
        old.update = {
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
      if (!gaps.length && github.discussion) old.discussion = discussion;
      old.snapshots = changed ? snapshots : previous;
      old.run = null;
      store.saveSession(old);
      for (const snap of old.snapshots.filter((s) => s.pr)) {
        const prior = previous.find((s) => s.repoId === snap.repoId);
        const draft = drafts.find((d) => d.snapshotId === prior?.id);
        if (draft && draft.state === 'draft')
          store.saveDraft({
            ...draft,
            snapshotId: snap.id,
            headSha: snap.headSha,
            attempt: null,
            submission: null,
            comments:
              prior?.headSha === snap.headSha
                ? draft.comments
                : draft.comments.map((c) => ({
                    ...c,
                    selected: false,
                    evidence: null,
                    body: c.body.startsWith('[Требуется перепроверка после обновления PR]')
                      ? c.body
                      : `[Требуется перепроверка после обновления PR]\n${c.body}`,
                  })),
          });
      }
      return old;
    }),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/analyze', async (req) =>
    exclusive(req.params.id, async () => analysis.start(session(req.params.id))),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/scenario-analysis', async (req) =>
    exclusive(req.params.id, async () => analysis.startScenarios(session(req.params.id))),
  );
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
    const current = session(sessionId);
    const snapshot = [
      ...current.snapshots,
      ...(current.history ?? []).flatMap((revision) => revision.snapshots),
    ].find((item) => item.id === query.snapshotId);
    if (!snapshot) throw new AppError('Снимок не найден.', 404);
    return { ...query, snapshot };
  };
  app.get<{ Params: { id: string } }>('/api/sessions/:id/viewed-methods', async (req) => {
    const target = methodViewTarget(req.params.id, req.query);
    return viewedMethods.list(req.params.id, target.snapshot, target.path, target.side);
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
    const available = [
      ...current.snapshots,
      ...(current.history ?? []).flatMap((revision) => revision.snapshots),
    ];
    const ids = query.snapshotIds?.split(',') ?? current.snapshots.map((snapshot) => snapshot.id);
    const selected = [...new Set(ids)].map((id) => {
      const snapshot = available.find((item) => item.id === id);
      if (!snapshot) throw new AppError('Снимок не найден.', 404);
      return snapshot;
    });
    return viewedFiles.list(current.id, selected);
  });
  app.put<{ Params: { id: string } }>('/api/sessions/:id/viewed-files', async (req) => {
    const body = z
      .object({ snapshotId: z.string(), path: z.string(), viewed: z.boolean() })
      .parse(req.body);
    const current = session(req.params.id),
      snapshot = [
        ...current.snapshots,
        ...(current.history ?? []).flatMap((revision) => revision.snapshots),
      ].find((item) => item.id === body.snapshotId);
    if (!snapshot) throw new AppError('Снимок не найден.', 404);
    return viewedFiles.set(current.id, snapshot, body.path, body.viewed);
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
      snap = [...s.snapshots, ...(s.history ?? []).flatMap((revision) => revision.snapshots)].find(
        (snap) => snap.repoId === q.repoId && (!q.snapshotId || snap.id === q.snapshotId),
      );
    if (!snap) throw new AppError('Репозиторий не найден.', 404);
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
  app.get<{ Params: { id: string } }>('/api/sessions/:id/database-schema', async (req) => {
    const { snapshotId } = z.object({ snapshotId: z.string() }).parse(req.query);
    const current = session(req.params.id);
    const snapshot = [
      ...current.snapshots,
      ...(current.history ?? []).flatMap((revision) => revision.snapshots),
    ].find((snapshot) => snapshot.id === snapshotId);
    if (!snapshot) throw new AppError('Снимок не найден.', 404);
    return databaseSchema(snapshot);
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
    const current = session(sessionId);
    const snapshot = [
      ...current.snapshots,
      ...(current.history ?? []).flatMap((revision) => revision.snapshots),
    ].find((snap) => snap.id === q.snapshotId && snap.repoId === q.repoId);
    if (!snapshot) throw new AppError('Снимок не найден.', 404);
    const indexKey = `${INDEX_VERSION}:${snapshot.repoId}:${q.side}:${q.side === 'head' ? snapshot.headSha : snapshot.mergeBase}`;
    const cachedIndex = store.index(indexKey);
    const index = cachedIndex ?? (await indexSnapshot(snapshot, q.side));
    if (!cachedIndex) store.saveIndex(indexKey, index);
    const methods = index.methods.filter(
      (method) =>
        method.evidence.path === q.path &&
        method.evidence.startLine <= q.line &&
        method.evidence.endLine >= q.line,
    );
    if (methods.length !== 1)
      throw new AppError('Метод запроса не удалось однозначно определить.', 422);
    const method = methods[0];
    const key = JSON.stringify([sessionId, snapshot.id, q.side, q.path, method.evidence.startLine]);
    return { q, snapshot, method, key };
  };
  app.post<{ Params: { id: string } }>('/api/sessions/:id/sql-analysis', async (req) =>
    exclusive(req.params.id, async () => analysis.startSql(session(req.params.id))),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/test-analysis', async (req) =>
    exclusive(req.params.id, async () => analysis.startTests(session(req.params.id))),
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id/sql-preview', async (req) => {
    const target = await queryTarget(req.params.id, req.query);
    const captured = store.sqlCapture(target.key);
    if (captured) return captured.preview;
    const current = session(req.params.id);
    const result = current.snapshots.some((snapshot) => snapshot.id === target.snapshot.id)
      ? current.run?.result
      : current.history?.find((revision) =>
          revision.snapshots.some((snapshot) => snapshot.id === target.snapshot.id),
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
        throw new AppError('SQL относится к другому head SHA. Импорт отклонён.', 409);
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
          'SQL импортирован из предоставленной трассировки приложения. Его происхождение не проверяется автоматически.',
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
    return s.snapshots.filter((s) => s.pr).map((snap) => review.get(s, snap));
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
    '/api/sessions/:id/drafts/:snapshotId/submit',
    async (req) =>
      exclusive(req.params.id, async () => {
        const s = session(req.params.id);
        return review.publish(s, snapshot(s, req.params.snapshotId));
      }),
  );
  app.post<{ Params: { id: string; snapshotId: string } }>(
    '/api/sessions/:id/drafts/:snapshotId/reconcile',
    async (req) => {
      const s = session(req.params.id);
      return review.reconcile(s, snapshot(s, req.params.snapshotId));
    },
  );
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.register(staticPlugin, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Маршрут не найден.' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    await analysis.stopAll();
    await Promise.allSettled(upgrades.values());
    store.close();
  });
  return { app, store, analysis, review };
}
