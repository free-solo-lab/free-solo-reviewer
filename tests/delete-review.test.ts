import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { createApp } from '../server/app';
import { createSnapshot } from '../server/repository';
import { fixture, FixtureProvider } from './fixtures';
import {
  emptyModelResult,
  type AnalysisRun,
  type ReviewDraft,
  type ReviewSession,
} from '../shared/model';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
async function setup() {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const dataDir = join(f.root, 'delete-app');
  const { app, store } = createApp({ dataDir, github: f.github, provider: new FixtureProvider() });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const request = (
    method: 'POST' | 'GET' | 'DELETE',
    url: string,
    payload?: unknown,
    origin?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:4318',
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const create = async () =>
    (
      await request('POST', '/api/sessions', {
        title: 'Delete fixture',
        repositories: [{ repoId: f.repo.id, prNumber: 12 }],
      })
    ).json<ReviewSession>();
  const run = (session: ReviewSession, fingerprint: string): AnalysisRun => ({
    id: fingerprint,
    sessionId: session.id,
    fingerprint,
    version: '1',
    state: 'complete',
    startedAt: '',
    events: [],
    result: { ...emptyModelResult(), summary: fingerprint, contracts: [], indexes: [] },
  });
  return { ...f, app, store, dataDir, request, create, run };
}
describe('deleting saved PR reviews', () => {
  it('removes local history, drafts, unshared caches and snapshots while preserving other reviews and GitHub', async () => {
    const f = await setup(),
      first = await f.create(),
      second = await f.create();
    const orphan = await createSnapshot(f.repo, 12, join(f.dataDir, 'snapshots'), f.github);
    first.run = f.run(first, 'shared-cache');
    second.run = f.run(second, 'shared-cache');
    first.history = [
      {
        id: 'shared',
        savedAt: '',
        snapshots: second.snapshots,
        run: f.run(first, 'history-cache'),
        drafts: [],
      },
      {
        id: 'orphan',
        savedAt: '',
        snapshots: [orphan],
        run: f.run(first, 'orphan-cache'),
        drafts: [],
      },
    ];
    f.store.saveSession(first);
    f.store.saveSession(second);
    for (const fingerprint of ['shared-cache', 'history-cache', 'orphan-cache'])
      f.store.saveAnalysisResult(fingerprint, first.run.result);
    const draft = (await f.request('GET', `/api/sessions/${first.id}/drafts`)).json<
      ReviewDraft[]
    >()[0];
    f.store.saveDraft({ ...draft, body: 'Saved text' });
    f.store.saveDraft({ ...draft, snapshotId: orphan.id, body: 'Old text' });
    const removed = await f.request('DELETE', `/api/sessions/${first.id}`, {});
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, warnings: [] });
    expect((await f.request('GET', `/api/sessions/${first.id}`)).statusCode).toBe(404);
    expect(f.store.drafts(first.id)).toEqual([]);
    expect(f.store.session(second.id)).toEqual(second);
    expect(f.store.analysisResult('shared-cache')).toBeDefined();
    expect(f.store.analysisResult('history-cache')).toBeUndefined();
    expect(f.store.analysisResult('orphan-cache')).toBeUndefined();
    expect(await exists(first.snapshots[0].headDir)).toBe(false);
    expect(await exists(orphan.headDir)).toBe(false);
    expect(await exists(second.snapshots[0].headDir)).toBe(true);
    expect(f.github.submissions).toEqual([]);
    expect(f.store.repository(f.repo.id)).toEqual(f.repo);
    expect((await f.request('DELETE', `/api/sessions/${second.id}`, {})).statusCode).toBe(200);
    expect(f.store.analysisResult('shared-cache')).toBeUndefined();
    expect(await exists(second.snapshots[0].headDir)).toBe(false);
    expect((await f.request('DELETE', `/api/sessions/${first.id}`, {})).statusCode).toBe(404);
  });
  it('rejects deletion during analysis, uncertain publishing, or from a foreign origin', async () => {
    const f = await setup(),
      session = await f.create();
    session.run = { ...f.run(session, 'active'), state: 'running' };
    f.store.saveSession(session);
    expect((await f.request('DELETE', `/api/sessions/${session.id}`, {})).statusCode).toBe(409);
    expect(f.store.session(session.id)).toBeDefined();
    session.run.state = 'complete';
    f.store.saveSession(session);
    const draft = (await f.request('GET', `/api/sessions/${session.id}/drafts`)).json<
      ReviewDraft[]
    >()[0];
    f.store.saveDraft({ ...draft, state: 'uncertain' });
    expect((await f.request('DELETE', `/api/sessions/${session.id}`, {})).statusCode).toBe(409);
    f.store.saveDraft(draft);
    expect(
      (await f.request('DELETE', `/api/sessions/${session.id}`, {}, 'https://untrusted.example'))
        .statusCode,
    ).toBe(403);
    expect(f.store.session(session.id)).toBeDefined();
    expect(await exists(session.snapshots[0].headDir)).toBe(true);
  });
});
