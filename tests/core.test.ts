import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { fixture, FixtureProvider } from './fixtures.js';
import { parsePatch, readSource, safePath } from '../server/repository.js';
import { indexSnapshot } from '../server/indexer.js';
import { extractContracts } from '../server/contracts.js';
import { decodeModelResult, validateModelResult } from '../server/validation.js';
import { Store } from '../server/store.js';
import { GitHubApiError, githubErrorMessage, parseHttpResponse } from '../server/github.js';
import { AnalysisManager } from '../server/analysis.js';
import { createApp } from '../server/app.js';
import { buildContext } from '../server/provider.js';
import { serviceGroups } from '../shared/graph.js';
import { emptyModelResult, type ReviewSession } from '../shared/model.js';
import { cleanup, reviewFixture, setup, waitFor } from './core-fixtures.js';
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
  it("shows GitHub's validation details instead of a bare status text", () => {
    expect(
      githubErrorMessage(
        '{"message":"Unprocessable Entity","errors":["Review Can not approve your own pull request"]}',
      ),
    ).toBe('Unprocessable Entity: Review Can not approve your own pull request');
    expect(
      githubErrorMessage(
        '{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","field":"line","code":"invalid"}]}',
      ),
    ).toBe('Validation Failed: line: invalid');
    expect(githubErrorMessage('{"message":"Not Found"}')).toBe('Not Found');
    expect(githubErrorMessage('<html>')).toBe('GitHub отклонил запрос');
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
