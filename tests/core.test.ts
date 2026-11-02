import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture, FixtureProvider } from './fixtures.js';
import {
  createSnapshot,
  inlineLocation,
  parsePatch,
  readSource,
  safePath,
} from '../server/repository.js';
import { indexSnapshot, INDEX_VERSION } from '../server/indexer.js';
import { extractContracts } from '../server/contracts.js';
import { decodeModelResult, validateModelResult } from '../server/validation.js';
import { Store } from '../server/store.js';
import { GitHubApiError, parseHttpResponse } from '../server/github.js';
import { ReviewManager } from '../server/review.js';
import { AnalysisManager } from '../server/analysis.js';
import { createApp } from '../server/app.js';
import { codexOptions, buildContext, codexOutputSchema } from '../server/provider.js';
import { serviceGroups } from '../shared/graph.js';
import { emptyModelResult, type ReviewSession } from '../shared/model.js';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup() {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  return { ...f, snapshot };
}
async function reviewFixture() {
  const f = await setup();
  const store = new Store(join(f.root, 'review.sqlite'));
  cleanup.push(() => store.close());
  const session: ReviewSession = {
    id: randomUUID(),
    title: 'Review',
    createdAt: new Date().toISOString(),
    snapshots: [f.snapshot],
    run: {
      id: 'run',
      sessionId: 'session',
      version: '1',
      fingerprint: 'hash',
      state: 'complete',
      startedAt: new Date().toISOString(),
      events: [],
      result: { ...emptyModelResult(), indexes: [], contracts: [] },
    },
  };
  store.saveSession(session);
  const manager = new ReviewManager(store, f.github);
  const changed = f.snapshot.files.find((f) => f.path.endsWith('OrderService.java'))!;
  const evidence = {
    repoId: f.repo.id,
    side: 'head' as const,
    path: changed.path,
    startLine: changed.addedLines[0],
    endLine: changed.addedLines[0],
  };
  return { ...f, store, session, manager, evidence };
}
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
    expect(upgraded.run?.result.indexes[0].version).toBe(INDEX_VERSION);
    expect(store.session('saved')?.run?.result.indexes[0].version).toBe(INDEX_VERSION);
  });
});
describe('snapshot, syntax and source fidelity', () => {
  it('pins merge-base and PR head, preserves checkout, indexes Java and Kotlin, excludes credentials', async () => {
    const f = await setup();
    expect(f.snapshot.mergeBase).toBe(f.pr.baseRefOid);
    expect(f.snapshot.headSha).toBe(f.pr.headRefOid);
    expect(f.snapshot.headFiles).not.toContain('.env');
    expect(f.snapshot.files.find((f) => f.oldPath?.endsWith('Legacy.java'))?.path).toContain(
      'Renamed.java',
    );
    const index = await indexSnapshot(f.snapshot, 'head');
    expect(index.methods.map((m) => m.name)).toEqual(
      expect.arrayContaining(['createOrder', 'nested', 'charge']),
    );
    expect(index.methods.find((m) => m.name === 'createOrder')?.annotations.join()).toContain(
      '@Transactional',
    );
    expect(index.methods.find((m) => m.name === 'createOrder')?.calls).toContain(
      'paymentClient.charge',
    );
    await expect(readSource(f.snapshot, { side: 'head', path: '../../.env' })).rejects.toThrow();
    expect(() => safePath(f.root, '../escape')).toThrow();
    const context = await buildContext({ snapshots: [f.snapshot], indexes: [index] });
    expect(context.text).not.toContain('should-never-be-materialized');
    expect(context.text).toContain('paymentClient.charge');
  });
  it('maps added/deleted lines without confusing diff headers', () => {
    expect(parsePatch('--- a/Test\n+++ b/Test\n@@ -4,2 +4,3 @@\n keep\n-old\n+new\n+more')).toEqual(
      { addedLines: [5, 6], removedLines: [5] },
    );
  });
  it('extracts both OpenAPI versions and detects changed endpoints', async () => {
    const f = await setup(),
      contracts = await extractContracts(f.snapshot);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].before?.openapi).toBe('3.0.3');
    expect(contracts[0].changes.join()).toContain('Изменён endpoint /orders');
  });
  it('rejects hallucinated refs and downgrades model extraction claims', async () => {
    const f = await setup();
    const ref = {
      repoId: f.repo.id,
      side: 'head' as const,
      path: f.snapshot.headFiles.find((p) => p.endsWith('OrderService.java'))!,
      startLine: 1,
      endLine: 3,
    };
    const result = emptyModelResult();
    result.findings = [
      {
        id: 'real',
        title: 'Real',
        summary: 'Evidence',
        severity: 'low',
        confidence: 'extracted',
        evidence: [ref],
      },
      {
        id: 'fake',
        title: 'Fake',
        summary: 'No evidence',
        severity: 'high',
        confidence: 'extracted',
        evidence: [{ ...ref, path: 'missing.java' }],
      },
    ];
    const checked = await validateModelResult(result, [f.snapshot]);
    expect(checked.findings).toHaveLength(1);
    expect(checked.findings[0].confidence).toBe('inferred');
    expect(checked.gaps.length).toBeGreaterThan(0);
  });
  it('groups cycles and orders components by call direction', () => {
    const step = (from: string, to: string) => ({
      id: from + to,
      kind: 'call' as const,
      from,
      to,
      label: 'call',
      branch: '',
      change: 'added' as const,
      confidence: 'inferred' as const,
      evidence: [],
    });
    expect(
      serviceGroups({
        services: ['c', 'b', 'a'],
        steps: [step('a', 'b'), step('b', 'a'), step('b', 'c')],
      }),
    ).toEqual([['a', 'b'], ['c']]);
  });
});
describe('analysis integrity', () => {
  it('preserves good sections when one model section is malformed', () => {
    const result = decodeModelResult({
      ...emptyModelResult(),
      summary: 'Valid summary',
      scenarios: [{ bad: 'scenario' }],
      database: [{ bad: 'database' }],
    });
    expect(result.summary).toBe('Valid summary');
    expect(result.scenarios).toEqual([]);
    expect(result.gaps.join()).toContain('scenarios');
    expect(result.gaps.join()).toContain('database');
  });
  it('preserves unknown status even with valid evidence', async () => {
    const f = await setup();
    const result = emptyModelResult();
    result.findings = [
      {
        id: 'unknown',
        title: 'Unknown',
        summary: 'Cannot establish',
        severity: 'info',
        confidence: 'unknown',
        evidence: [
          { repoId: f.repo.id, side: 'head', path: 'openapi.yaml', startLine: 1, endLine: 1 },
        ],
      },
    ];
    expect((await validateModelResult(result, [f.snapshot])).findings[0].confidence).toBe(
      'unknown',
    );
  });
  it('does not treat sequence responses as cyclic dependencies', () => {
    const common = {
      label: 'call',
      branch: '',
      change: 'added' as const,
      confidence: 'inferred' as const,
      evidence: [],
    };
    expect(
      serviceGroups({
        services: ['orders', 'payments'],
        steps: [
          { ...common, id: 'call', from: 'orders', to: 'payments', kind: 'call' },
          { ...common, id: 'reply', from: 'payments', to: 'orders', kind: 'return' },
        ],
      }),
    ).toEqual([['orders'], ['payments']]);
  });
  it('rejects evidence outside actual file line ranges', async () => {
    const f = await setup();
    const result = emptyModelResult();
    result.findings = [
      {
        id: 'range',
        title: 'Invalid',
        summary: 'Range',
        severity: 'high',
        confidence: 'inferred',
        evidence: [
          { repoId: f.repo.id, side: 'head', path: 'openapi.yaml', startLine: 100, endLine: 100 },
        ],
      },
    ];
    expect((await validateModelResult(result, [f.snapshot])).findings).toHaveLength(0);
  });
  it('reuses unchanged analysis without another model call', async () => {
    const f = await reviewFixture();
    let calls = 0;
    const delegate = new FixtureProvider();
    const manager = new AnalysisManager(f.store, {
      id: 'cached',
      analyze(...args) {
        calls++;
        return delegate.analyze(...args);
      },
    });
    f.session.run = null;
    manager.start(f.session);
    await waitFor(() => f.store.session(f.session.id)?.run?.state !== 'running');
    const next = f.store.session(f.session.id)!;
    next.run = null;
    const cached = manager.start(next);
    expect(cached.state).toBe('complete');
    expect(calls).toBe(1);
    expect(cached.events[0].message).toContain('кэша');
    next.run = null;
    manager.restoreCached(next);
    expect(f.store.session(next.id)?.run?.state).toBe('complete');
    expect(calls).toBe(1);
  });
  it('keeps analysing when a changed SQL file cannot be read', async () => {
    const f = await reviewFixture();
    const sql = f.snapshot.files.find((file) => file.path.endsWith('.sql'))!;
    await rm(join(f.snapshot.headDir, sql.path));
    const manager = new AnalysisManager(f.store, new FixtureProvider());
    f.session.run = null;
    manager.start(f.session);
    await waitFor(() => f.store.session(f.session.id)?.run?.state !== 'running');
    const run = f.store.session(f.session.id)!.run!;
    expect(run.state).toBe('partial');
    expect(run.error).toBeUndefined();
    expect(run.result.gaps.join('\n')).toContain(sql.path);
    expect(run.result.findings.length).toBeGreaterThan(0);
  });
  it('refresh without new commits preserves snapshot IDs and draft selections', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const { app, store } = createApp({
      dataDir: join(f.root, 'refresh'),
      github: f.github,
      provider: new FixtureProvider(),
    });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const s = (
      await inject('POST', '/api/sessions', {
        title: 'Refresh',
        repositories: [{ repoId: f.repo.id, prNumber: 12 }],
      })
    ).json<ReviewSession>();
    const draft = (await inject('GET', `/api/sessions/${s.id}/drafts`)).json<
      ReturnType<Store['drafts']>
    >()[0];
    await inject('PUT', `/api/sessions/${s.id}/drafts/${draft.snapshotId}`, {
      ...draft,
      body: 'Keep me',
      comments: [
        {
          id: 'c',
          body: 'Verify this',
          selected: true,
          evidence: {
            repoId: f.repo.id,
            side: 'head',
            path: 'openapi.yaml',
            startLine: 1,
            endLine: 1,
          },
        },
      ],
    });
    const response = await inject('POST', `/api/sessions/${s.id}/refresh`, {});
    expect(response.statusCode).toBe(200);
    const updated = (await inject('GET', `/api/sessions/${s.id}/drafts`)).json<
      ReturnType<Store['drafts']>
    >()[0];
    expect(updated.body).toBe('Keep me');
    expect(updated.snapshotId).toBe(draft.snapshotId);
    expect(updated.comments[0]).toMatchObject({
      selected: true,
      evidence: { path: 'openapi.yaml' },
    });
    expect(response.json<ReviewSession>().run).toBeNull();
  });
});
describe('review publishing', () => {
  for (const state of ['cancelled', 'failed', 'running', 'none'] as const)
    it(`allows manually prepared comments when analysis is ${state}`, async () => {
      const f = await reviewFixture();
      if (state === 'none') f.session.run = null;
      else f.session.run!.state = state;
      f.manager.save(f.session, f.snapshot, {
        ...f.manager.get(f.session, f.snapshot),
        comments: [
          { id: 'manual', body: 'Manual review comment', evidence: f.evidence, selected: true },
        ],
      });
      expect((await f.manager.publish(f.session, f.snapshot)).state).toBe('submitted');
      expect(f.github.submissions[0].comments).toHaveLength(1);
    });

  for (const action of ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const)
    it(`publishes ${action} with explicit head and correct inline location`, async () => {
      const f = await reviewFixture();
      let draft = f.manager.get(f.session, f.snapshot);
      draft = f.manager.save(f.session, f.snapshot, {
        ...draft,
        body: 'Reviewed',
        action,
        comments: [{ id: 'c', body: 'Check compensation', evidence: f.evidence, selected: true }],
      });
      const published = await f.manager.publish(f.session, f.snapshot);
      expect(published.state).toBe('submitted');
      expect(f.github.submissions[0]).toMatchObject({
        event: action,
        commit_id: f.pr.headRefOid,
        comments: [
          {
            path: f.evidence.path,
            line: f.evidence.startLine,
            side: 'RIGHT',
            body: 'Check compensation',
          },
        ],
      });
      await f.manager.publish(f.session, f.snapshot);
      expect(f.github.submissions).toHaveLength(1);
    });
  it('supports LEFT comments, context comments and deselection', async () => {
    const f = await reviewFixture();
    const openapi = f.snapshot.files.find((f) => f.path === 'openapi.yaml')!;
    const ref = {
      repoId: f.repo.id,
      side: 'base' as const,
      path: 'openapi.yaml',
      startLine: openapi.removedLines[0],
      endLine: openapi.removedLines[0],
    };
    expect(inlineLocation(f.snapshot, ref)?.side).toBe('LEFT');
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
      comments: [
        { id: 'l', body: 'Removed', evidence: ref, selected: true },
        { id: 'g', body: 'General', evidence: null, selected: true },
        { id: 'skip', body: 'Skip', evidence: null, selected: false },
      ],
    });
    await f.manager.publish(f.session, f.snapshot);
    expect(f.github.submissions[0].comments[0].side).toBe('LEFT');
    expect(f.github.submissions[0].body).toContain('General');
    expect(f.github.submissions[0].body).not.toContain('Skip');
  });
  it('blocks stale PRs and invalidates self approval', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
      action: 'APPROVE',
    });
    f.github.changed = true;
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('новые коммиты');
    expect(f.github.submissions).toHaveLength(0);
    f.github.changed = false;
    f.github.login = 'author';
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('собственного PR');
  });
  it('reconciles accepted request after timeout without duplicate publication', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
    });
    f.github.throwAfterSubmit = true;
    expect((await f.manager.publish(f.session, f.snapshot)).state).toBe('submitted');
    await f.manager.publish(f.session, f.snapshot);
    expect(f.github.submissions).toHaveLength(1);
  });
  it('persists uncertainty and refuses blind retry when outcome cannot be established', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
    });
    f.github.throwBeforeSubmit = true;
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('не подтвердил');
    expect(f.manager.get(f.session, f.snapshot).state).toBe('uncertain');
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('Результат предыдущей');
    expect(f.github.submissions).toHaveLength(0);
  });
});
describe('GitHub failure responses', () => {
  it('parses included headers without mixing them into JSON', () => {
    expect(
      parseHttpResponse('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":12}'),
    ).toEqual({ status: 200, body: '{"id":12}' });
    expect(
      parseHttpResponse(
        'HTTP/2.0 422 Unprocessable Entity\nContent-Type: application/json\n\n{"message":"Validation failed"}',
      ).status,
    ).toBe(422);
  });
  it('keeps a definitely rejected review editable rather than marking it uncertain', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
    });
    f.github.submit = async () => {
      throw new GitHubApiError('Validation failed', 422);
    };
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow(
      'доступен для исправления',
    );
    expect(f.manager.get(f.session, f.snapshot).state).toBe('draft');
    expect(f.manager.get(f.session, f.snapshot).attempt).toBeNull();
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
    visit(codexOutputSchema);
    expect(codexOutputSchema.required).toContain('followUp');
    expect(codexOutputSchema.required).not.toContain('transactions');
    expect(codexOutputSchema.properties).not.toHaveProperty('transactions');
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
async function waitFor(condition: () => boolean) {
  const until = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > until) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
