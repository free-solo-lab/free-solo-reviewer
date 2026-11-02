import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fixture, FixtureProvider } from './fixtures.js';
import { indexSnapshot, INDEX_VERSION } from '../server/indexer.js';
import { decodeModelResult } from '../server/validation.js';
import { Store } from '../server/store.js';
import { AnalysisManager } from '../server/analysis.js';
import { createApp } from '../server/app.js';
import { codexOptions, buildContext, testTitlesSchema } from '../server/provider.js';
import { wireOutputSchema } from '../server/wire-format.js';
import { emptyModelResult, type ReviewSession, type SourceIndex } from '../shared/model.js';
import { cleanup, reviewFixture, setup, waitFor } from './core-fixtures.js';
describe('saved source index upgrades', () => {
  it('upgrades saved indexes without invoking the provider or changing model results', async () => {
    const f = await setup();
    const provider = new FixtureProvider();
    provider.analyze = async () => {
      throw new Error('LLM must not run');
    };
    const { app, store } = createApp({
      dataDir: join(f.root, 'upgrade'),
      github: f.github,
      provider,
    });
    cleanup.push(() => app.close());
    const oldIndex = await indexSnapshot(f.snapshot, 'head');
    delete oldIndex.version;
    const saved: ReviewSession = {
      id: 'saved',
      title: 'Saved',
      createdAt: new Date().toISOString(),
      snapshots: [f.snapshot],
      run: {
        id: 'run',
        sessionId: 'saved',
        version: '1',
        fingerprint: 'cached',
        state: 'complete',
        startedAt: new Date().toISOString(),
        events: [],
        result: {
          ...emptyModelResult(),
          summary: 'Keep this analysis',
          contracts: [],
          indexes: [oldIndex],
        },
      },
    };
    store.saveSession(saved);
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/saved',
      headers: { host: '127.0.0.1:4318' },
    });
    expect(response.statusCode).toBe(200);
    const upgraded = response.json<ReviewSession>();
    expect(upgraded.run?.id).toBe('run');
    expect(upgraded.run?.result.summary).toBe('Keep this analysis');
    expect(upgraded.run?.result.indexes).toEqual([]);
    const [ref] = upgraded.run?.result.indexRefs ?? [];
    expect(ref).toBe(`${INDEX_VERSION}:${f.snapshot.repoId}:head:${f.snapshot.headSha}`);
    const index = await app.inject({
      method: 'GET',
      url: `/api/indexes/${encodeURIComponent(ref)}`,
      headers: { host: '127.0.0.1:4318' },
    });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).toContain('immutable');
    expect(index.json<SourceIndex>().version).toBe(INDEX_VERSION);
    expect(store.session('saved')?.run?.result.indexes[0].version).toBe(INDEX_VERSION);
  });
  it('stores each index once and keeps sessions as references', async () => {
    const f = await reviewFixture();
    const index = await indexSnapshot(f.snapshot, 'head');
    const run = (id: string): ReviewSession['run'] => ({
      id,
      sessionId: 'shared',
      version: '1',
      fingerprint: id,
      state: 'complete',
      startedAt: new Date().toISOString(),
      events: [],
      result: { ...emptyModelResult(), contracts: [], indexes: [index] },
    });
    f.store.saveSession({
      id: 'shared',
      title: 'Shared',
      createdAt: new Date().toISOString(),
      snapshots: [f.snapshot],
      run: run('current'),
      history: [{ id: 'old', savedAt: '', snapshots: [f.snapshot], run: run('old')!, drafts: [] }],
    });
    const stored = f.store.sessions().find((item) => item.id === 'shared')!;
    expect(stored.run?.result.indexes).toEqual([]);
    expect(stored.history?.[0].run.result.indexRefs).toEqual(stored.run?.result.indexRefs);
    const loaded = f.store.session('shared')!;
    expect(loaded.run?.result.indexes[0].methods.length).toBe(index.methods.length);
    expect(loaded.history?.[0].run.result.indexes[0]).toBe(loaded.run?.result.indexes[0]);
  });
  it('leaves indexes embedded when their commit is unknown', () => {
    const store = new Store(':memory:');
    const index = {
      repoId: 'missing',
      side: 'head' as const,
      methods: [],
      errors: [],
      filesIndexed: 0,
    };
    const result = { ...emptyModelResult(), contracts: [], indexes: [index] };
    expect(store.detachResult(result, [])).toBe(result);
    store.close();
  });
  it('compacts sessions saved with embedded indexes on startup', async () => {
    const f = await setup();
    const path = join(f.root, 'legacy.sqlite');
    const index = await indexSnapshot(f.snapshot, 'head');
    const legacy: ReviewSession = {
      id: 'legacy',
      title: 'Legacy',
      createdAt: new Date().toISOString(),
      snapshots: [f.snapshot],
      run: {
        id: 'run',
        sessionId: 'legacy',
        version: '1',
        fingerprint: 'legacy',
        state: 'complete',
        startedAt: new Date().toISOString(),
        events: [],
        result: { ...emptyModelResult(), contracts: [], indexes: [index] },
      },
    };
    new Store(path).close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO objects(kind,id,json) VALUES(?,?,?)').run(
      'session',
      'legacy',
      JSON.stringify(legacy),
    );
    db.close();
    const store = new Store(path);
    cleanup.push(() => store.close());
    store.recover();
    expect(store.sessions()[0].run?.result.indexRefs).toHaveLength(1);
    expect(store.session('legacy')?.run?.result.indexes[0].methods).toEqual(index.methods);
  });
});
describe('jobs, persistence and local API', () => {
  it('requires every structured output field and accepts null followUp for initial reviews', () => {
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const schema = node as Record<string, any>;
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(schema.properties).sort());
      }
      for (const value of Object.values(schema)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
          visit(value);
          Object.values(value).forEach(visit);
        }
      }
    };
    visit(wireOutputSchema);
    visit(testTitlesSchema);
    expect(wireOutputSchema.required).toContain('followUp');
    expect(wireOutputSchema.required).not.toContain('transactions');
    expect(wireOutputSchema.properties).not.toHaveProperty('transactions');
    const { transactions: _legacy, ...current } = emptyModelResult();
    const raw = { ...current, summary: 'Initial review', followUp: null };
    const decoded = decodeModelResult(raw);
    expect(decoded.summary).toBe('Initial review');
    expect(decoded.followUp).toBeUndefined();
    expect(decoded.transactions).toEqual([]);
    expect(decoded.gaps).toEqual([]);
  });
  it('excludes legacy transaction reports and reaction metadata from Codex context', async () => {
    const previous = {
      ...emptyModelResult(),
      summary: 'Preserved review',
      transactions: [
        {
          id: 'legacy-tx',
          title: 'Legacy report',
          summary: 'x'.repeat(600_000),
          confidence: 'inferred' as const,
          evidence: [],
          propagation: 'REQUIRED',
          rollback: '',
          operations: [],
          unknowns: [],
        },
      ],
    };
    const context = await buildContext({
      snapshots: [],
      indexes: [],
      followUp: {
        previousReviewId: 'old',
        previous,
        comments: [],
        reviewBodies: [],
        changes: [],
        discussion: [
          {
            id: 'inline:1',
            repoId: 'repo',
            body: 'The answer matters',
            author: 'author',
            url: '',
            at: '',
            updatedAt: '',
            reactions: [{ content: '+1', count: 99, viewerHasReacted: true }],
          },
        ],
        discussionContext: [
          {
            id: 'inline:2',
            repoId: 'repo',
            body: 'Original question',
            author: 'reviewer',
            url: '',
            at: '',
            updatedAt: '',
            reactions: [{ content: 'heart', count: 2 }],
          },
        ],
        gaps: [],
      },
    });
    expect(context.truncated).toBe(false);
    const data = JSON.parse(context.text);
    expect(data.followUp.previous).not.toHaveProperty('transactions');
    expect(data.followUp.previous.summary).toBe('Preserved review');
    expect(previous.transactions[0].summary).toHaveLength(600_000);
    expect(data.followUp.discussion[0].body).toBe('The answer matters');
    expect(data.followUp.discussion[0]).not.toHaveProperty('reactions');
    expect(data.followUp.discussionContext[0]).not.toHaveProperty('reactions');
  });
  it('retries an empty partial run and analyzes again after deleting its saved review', async () => {
    const f = await reviewFixture();
    f.session.run = null;
    const delegate = new FixtureProvider();
    let calls = 0;
    const manager = new AnalysisManager(f.store, {
      id: 'retry-provider',
      async analyze(...args) {
        calls++;
        if (calls === 1) throw new Error('Invalid output schema');
        expect(args[0].followUp).toBeUndefined();
        return delegate.analyze(...args);
      },
    });
    manager.start(f.session);
    await waitFor(() => f.store.session(f.session.id)?.run?.state !== 'running');
    const partial = f.store.session(f.session.id)!;
    expect(partial.run?.error).toBe('Invalid output schema');
    expect(f.store.analysisResult(partial.run!.fingerprint)).toBeUndefined();
    manager.start(partial);
    await waitFor(() => f.store.session(f.session.id)?.run?.state !== 'running');
    const complete = f.store.session(f.session.id)!;
    expect(complete.run?.state).toBe('complete');
    expect(complete.run?.result.summary).not.toBe('');
    expect(complete.history ?? []).toHaveLength(0);
    expect(calls).toBe(2);
    manager.start(complete);
    expect(calls).toBe(2);
    f.store.deleteSession(complete.id);
    expect(f.store.analysisResult(complete.run!.fingerprint)).toBeUndefined();
    const recreated = { ...f.session, id: randomUUID(), run: null };
    manager.start(recreated);
    await waitFor(() => f.store.session(recreated.id)?.run?.state !== 'running');
    expect(calls).toBe(3);
    expect(f.store.session(recreated.id)?.run?.state).toBe('complete');
  });
  it('preserves extracted sections on model failure', async () => {
    const f = await reviewFixture();
    f.session.run = null;
    const manager = new AnalysisManager(f.store, {
      id: 'failing',
      async analyze() {
        throw new Error('Model unavailable');
      },
    });
    manager.start(f.session);
    await waitFor(() => f.store.session(f.session.id)?.run?.state !== 'running');
    const run = f.store.session(f.session.id)!.run!;
    expect(run.state).toBe('partial');
    expect(run.result.contracts).toHaveLength(1);
    expect(run.result.database.some((d) => d.kind === 'migration')).toBe(true);
    expect(run.result.gaps.join()).toContain('Model unavailable');
    expect(run.error).toBe('Model unavailable');
    expect(run.events.some((event) => event.message.includes('Ошибка анализа:'))).toBe(true);
  });
  it('supports cancellation and restart recovery', async () => {
    const f = await reviewFixture();
    f.session.run = null;
    const manager = new AnalysisManager(f.store, {
      id: 'cancel',
      async analyze(_i, signal) {
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          if (signal.aborted) reject(new Error('cancelled'));
        });
        return emptyModelResult();
      },
    });
    manager.start(f.session);
    manager.cancel(f.session.id);
    await waitFor(() => f.store.session(f.session.id)?.run?.state === 'cancelled');
    f.session.run!.state = 'running';
    f.store.saveSession(f.session);
    f.store.recover();
    expect(f.store.session(f.session.id)?.run?.state).toBe('failed');
  });
  it('runs real Git import → analysis → draft → review through API and rejects cross-origin mutations', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const { app, store } = createApp({
      dataDir: join(f.root, 'app'),
      github: f.github,
      provider: new FixtureProvider(),
    });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const inject = (
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      payload?: unknown,
      origin?: string,
    ) =>
      app.inject({
        method,
        url,
        headers: {
          host: '127.0.0.1:4318',
          ...(origin ? { origin } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const denied = await inject(
      'POST',
      '/api/sessions',
      { title: 'x', repositories: [] },
      'https://evil.example',
    );
    expect(denied.statusCode).toBe(403);
    const created = await inject('POST', '/api/sessions', {
      title: 'Checkout',
      repositories: [{ repoId: f.repo.id, prNumber: 12 }],
    });
    expect(created.statusCode).toBe(200);
    const session = created.json<ReviewSession>();
    expect((await inject('POST', `/api/sessions/${session.id}/analyze`, {})).statusCode).toBe(200);
    await waitFor(() => store.session(session.id)?.run?.state !== 'running');
    expect(store.session(session.id)?.run?.state).toBe('complete');
    const draft = (await inject('GET', `/api/sessions/${session.id}/drafts`)).json<
      ReturnType<Store['drafts']>
    >()[0];
    expect(
      (
        await inject('PUT', `/api/sessions/${session.id}/drafts/${draft.snapshotId}`, {
          ...draft,
          body: 'Test review',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject('POST', `/api/sessions/${session.id}/drafts/${draft.snapshotId}/submit`, {})
      ).json().state,
    ).toBe('submitted');
    expect(f.github.submissions).toHaveLength(1);
  });
  it('Codex environment has no GitHub tokens or inherited connectors', () => {
    const old = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'super-secret';
    const config = codexOptions('/tmp/isolated');
    expect(config.options.env?.GH_TOKEN).toBeUndefined();
    expect(config.options.env?.HOME).toBe('/tmp/isolated');
    expect(config.options.config?.features).toEqual({ shell_tool: false, multi_agent: false });
    expect(config.thread.networkAccessEnabled).toBe(false);
    if (old) process.env.GH_TOKEN = old;
    else delete process.env.GH_TOKEN;
  });
});
