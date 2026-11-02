import { afterEach, describe, expect, it } from 'vitest';
import { sqlPreview } from '../server/sql-preview';
import {
  emptyModelResult,
  SQL_ANALYSIS_VERSION,
  type AnalysisResult,
  type IndexedMethod,
  type Snapshot,
} from '../shared/model';
import { AnalysisManager } from '../server/analysis';
import { Store } from '../server/store';
import { createSnapshot } from '../server/repository';
import { indexSnapshot } from '../server/indexer';
import { fixture, FixtureProvider } from './fixtures';
import { createApp } from '../server/app';
import { join } from 'node:path';
import type { ReviewSession } from '../shared/model';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe('SQL previews', () => {
  it('reads saved Codex variants and never substitutes SQL from another method or side', () => {
    const evidence = {
      repoId: 'repo',
      side: 'head' as const,
      path: 'Repository.kt',
      startLine: 10,
      endLine: 30,
    };
    const method: IndexedMethod = {
      name: 'find',
      signature: '',
      annotations: [],
      calls: [],
      evidence,
    };
    const snapshot = { id: 'snapshot', headSha: 'sha' } as Snapshot;
    const result: AnalysisResult = { ...emptyModelResult(), indexes: [], contracts: [] };
    expect(sqlPreview(snapshot, method, result).origin).toBe('unavailable');
    const query = {
      method: 'Repository.find',
      framework: 'jooq' as const,
      evidence,
      parameters: [{ position: 1, expression: 'id' }],
    };
    const operation = {
      id: 'q',
      title: 'Payment',
      summary: '',
      kind: 'jooq' as const,
      confidence: 'inferred' as const,
      evidence: [evidence],
      sql: 'select id from payment where id = ?',
      dialect: 'POSTGRES',
      tables: ['payment'],
      unknowns: [],
      query,
    };
    result.database = [operation];
    expect(sqlPreview(snapshot, method, result)).toMatchObject({
      origin: 'model',
      sql: operation.sql,
      parameters: query.parameters,
    });
    result.database.push({
      ...operation,
      id: 'q2',
      title: 'Payout',
      sql: '',
      unknowns: ['Missing payout mapping'],
    });
    const preview = sqlPreview(snapshot, method, result);
    expect(preview.variants).toHaveLength(2);
    expect(preview.variants?.[1].unknowns).toContain('Missing payout mapping');
    expect(sqlPreview(snapshot, { ...method, name: 'other' }, result).origin).toBe('unavailable');
    expect(
      sqlPreview(snapshot, { ...method, evidence: { ...evidence, side: 'base' } }, result).origin,
    ).toBe('unavailable');
  });
  it('retries SQL enrichment without changing the existing review and reuses saved results', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
    const index = await indexSnapshot(snapshot, 'head');
    const method = index.methods.find((m) => m.name === 'createOrder')!;
    method.callSites = [
      {
        name: 'save',
        receiver: 'repository',
        evidence: method.evidence,
        transactionIds: [],
        database: true,
      },
    ];
    const second = index.methods.find((m) => m.name === 'nested')!;
    second.callSites = [{ ...method.callSites[0], evidence: second.evidence }];
    const store = new Store(join(f.root, 'sql-enrichment.sqlite'));
    cleanup.push(async () => store.close());
    const previous = {
      ...emptyModelResult(),
      summary: 'Keep original Markdown',
      sqlAnalysisVersion: SQL_ANALYSIS_VERSION,
      contracts: [],
      indexes: [index],
    };
    const session: ReviewSession = {
      id: 'session',
      title: 'Existing review',
      createdAt: '',
      snapshots: [snapshot],
      run: {
        id: 'old',
        sessionId: 'session',
        version: '1',
        fingerprint: 'old',
        state: 'complete',
        startedAt: '',
        events: [],
        result: previous,
      },
    };
    store.saveSession(session);
    let calls = 0;
    const manager = new AnalysisManager(store, {
      id: 'sql-test',
      async analyze(input) {
        calls++;
        expect(input.sqlOnly).toBe(true);
        expect(input.sqlTargets?.map((m) => m.name)).toEqual(
          calls < 3 ? ['createOrder', 'nested'] : ['nested'],
        );
        if (calls === 1) throw new Error('Temporary model failure');
        const target = calls === 2 ? method : second;
        return {
          ...emptyModelResult(),
          summary: 'Must not replace summary',
          database: [
            {
              id: `sql:${target.name}`,
              title: 'Native insert',
              summary: '',
              kind: 'orm',
              confidence: 'inferred',
              evidence: [target.evidence],
              sql: 'insert into orders (id) values (?)',
              dialect: 'POSTGRES',
              tables: ['orders'],
              unknowns: [],
              query: {
                method: `Repository.${target.name}(FilterDto)`,
                framework: 'hibernate',
                evidence: target.evidence,
                parameters: [{ position: 1, expression: 'order.id' }],
              },
            },
          ],
        };
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.startSql(session);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const failed = store.session(session.id)!;
    expect(failed.run?.state).toBe('partial');
    expect(failed.run?.result.summary).toBe(previous.summary);
    expect(failed.run?.result.database).toEqual(previous.database);
    const resumedId = failed.run!.id;
    manager.resume(failed);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const partial = store.session(session.id)!;
    expect(partial.run?.state).toBe('partial');
    expect(partial.run?.result.sqlAnalysisVersion).toBeUndefined();
    expect(partial.run?.result.database).toHaveLength(1);
    expect(store.analysisResult(partial.run!.fingerprint)).toBeUndefined();
    manager.resume(partial);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const saved = store.session(session.id)!;
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.id).toBe(resumedId);
    expect(saved.run?.result.summary).toBe(previous.summary);
    expect(saved.history).toBeUndefined();
    expect(sqlPreview(snapshot, method, saved.run!.result).origin).toBe('model');
    expect(store.analysisResult(saved.run!.fingerprint)?.database).toHaveLength(2);
    manager.startSql(saved);
    expect(calls).toBe(3);
  });
  it('binds imported SQL to the pinned SHA and method, keeps it local, and deletes it with the review', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const { app, store } = createApp({
      dataDir: join(f.root, 'sql-app'),
      github: f.github,
      provider: new FixtureProvider(),
    });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const request = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const session = (
      await request('POST', '/api/sessions', {
        title: 'SQL',
        repositories: [{ repoId: f.repo.id, prNumber: 12 }],
      })
    ).json<ReviewSession>();
    const snapshot = session.snapshots[0],
      path = 'src/main/java/example/OrderService.java';
    const body = {
      repoId: f.repo.id,
      snapshotId: snapshot.id,
      path,
      side: 'head',
      line: 7,
      headSha: snapshot.headSha,
      framework: 'hibernate',
      dialect: 'PostgreSQL',
      sql: 'insert into orders (id) values (?)',
    };
    expect(
      (
        await request('POST', `/api/sessions/${session.id}/sql-capture`, {
          ...body,
          headSha: 'a'.repeat(40),
        })
      ).statusCode,
    ).toBe(409);
    const saved = await request('POST', `/api/sessions/${session.id}/sql-capture`, body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      origin: 'captured',
      sql: body.sql,
      headSha: snapshot.headSha,
    });
    const query = new URLSearchParams({
      repoId: f.repo.id,
      snapshotId: snapshot.id,
      path,
      side: 'head',
      line: '7',
    });
    expect(
      (await request('GET', `/api/sessions/${session.id}/sql-preview?${query}`)).json(),
    ).toMatchObject({ origin: 'captured', sql: body.sql });
    const key = JSON.stringify([
      session.id,
      snapshot.id,
      'head',
      path,
      saved.json().evidence.startLine,
    ]);
    expect(store.sqlCapture(key)).toBeDefined();
    expect((await request('DELETE', `/api/sessions/${session.id}`, {})).statusCode).toBe(200);
    expect(store.sqlCapture(key)).toBeUndefined();
    expect(f.github.submissions).toEqual([]);
  });
});
