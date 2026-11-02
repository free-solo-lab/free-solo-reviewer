import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { fixture, FixtureProvider } from './fixtures';
import type { ReviewSession, SourceIndex } from '../shared/model';
import { unpackIndex } from '../shared/index-wire';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('provides cached navigation on a pinned snapshot without starting analysis', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const { app, store } = createApp({
    dataDir: join(f.root, 'navigation'),
    github: f.github,
    provider: new FixtureProvider(),
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { host: '127.0.0.1:4318' },
    payload: { title: 'Navigation', repositories: [{ repoId: f.repo.id, prNumber: 12 }] },
  });
  expect(created.statusCode).toBe(200);
  const session = created.json<ReviewSession>();
  const url = `/api/sessions/${session.id}/navigation-index?snapshotId=${session.snapshots[0].id}&side=head`;
  const response = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4318' } });
  expect(response.statusCode).toBe(200);
  const index = unpackIndex(response.json<SourceIndex>());
  expect(index.methods.length).toBeGreaterThan(0);
  expect(index.types?.length).toBeGreaterThan(0);
  expect(index.methods.some((m) => m.owner)).toBe(true);
  expect(
    index.methods.every((m) => m.evidence.side === 'head' && m.evidence.repoId === f.repo.id),
  ).toBe(true);
  const repeated = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4318' } });
  expect(unpackIndex(repeated.json())).toEqual(index);
  expect(store.session(session.id)?.run).toBeNull();
  const missing = await app.inject({
    method: 'GET',
    url: url.replace(session.snapshots[0].id, 'missing'),
    headers: { host: '127.0.0.1:4318' },
  });
  expect(missing.statusCode).toBe(404);
});
