import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { createSnapshot, createLocalSnapshot } from '../server/repository';
import { git } from '../server/process';
import { createApp } from '../server/app';
import { emptyModelResult, type ReviewSession } from '../shared/model';
import type { ReviewRangeComparison } from '../shared/review-timeline';
import { ReviewComparisons } from '../server/review-comparison';
import { unpackIndex } from '../shared/index-wire';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('compares uncommitted local versions using the private snapshot repository', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const { app, store } = createApp({ dataDir: join(f.root, 'local-comparison') });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  await writeFile(join(f.repo.path, 'local.txt'), 'first review\n');
  const old = await createLocalSnapshot(f.repo, f.pr.baseRefOid, join(f.root, 'local-snapshots'));
  await writeFile(join(f.repo.path, 'local.txt'), 'fixed after review\n');
  const current = await createLocalSnapshot(
    f.repo,
    f.pr.baseRefOid,
    join(f.root, 'local-snapshots'),
  );
  const run = {
    id: 'local-first',
    sessionId: 'local',
    version: '1',
    fingerprint: 'local',
    state: 'complete' as const,
    startedAt: '2026-11-01T00:00:00Z',
    events: [],
    result: { ...emptyModelResult(), summary: 'Local review', indexes: [], contracts: [] },
  };
  const session: ReviewSession = {
    id: 'local',
    title: 'Local',
    createdAt: run.startedAt,
    snapshots: [current],
    run: null,
    history: [{ id: run.id, savedAt: run.startedAt, run, snapshots: [old], drafts: [] }],
  };
  const comparisons = new ReviewComparisons(store);
  const view = await comparisons.read(session, run.id);
  expect(view.snapshots[0].files.map((f) => f.path)).toEqual(['local.txt']);
  expect(view.snapshots[0].files[0].patch).toContain('-first review');
  expect(view.snapshots[0].files[0].patch).toContain('+fixed after review');
  expect((await comparisons.read(session, 'base')).snapshots[0].files.map((f) => f.path)).toContain(
    'openapi.yaml',
  );
});
it('compares saved reviews only to current source, serves the correct old code, contracts and marks, without analysis or session mutation', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const analyzed = vi.fn();
  const { app, store } = createApp({
    dataDir: join(f.root, 'comparison-data'),
    github: f.github,
    provider: { id: 'no-analysis', analyze: analyzed },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const old = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const path = 'src/main/java/example/OrderService.java';
  const before = await readFile(join(f.repo.path, path), 'utf8');
  await writeFile(
    join(f.repo.path, path),
    before.replace('    return order;', '    order.toString();\n    return order;'),
  );
  await writeFile(
    join(f.repo.path, 'openapi.yaml'),
    (await readFile(join(f.repo.path, 'openapi.yaml'), 'utf8')).replace('2.0.0', '2.1.0'),
  );
  await rm(join(f.repo.path, 'src/main/java/example/Renamed.java'));
  await git(f.repo.path, ['add', '.']);
  await git(f.repo.path, ['commit', '-m', 'Review fixes']);
  const sha = (await git(f.repo.path, ['rev-parse', 'HEAD'])).trim();
  await git(f.repo.path, ['push', '--force', 'origin', `${sha}:refs/pull/12/head`]);
  f.github.pr = { ...f.github.pr, headRefOid: sha };
  const current = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const run = {
    id: 'first',
    sessionId: 'session',
    state: 'complete' as const,
    startedAt: '2026-10-29T00:00:00Z',
    events: [],
    version: '1',
    fingerprint: 'saved',
    result: { ...emptyModelResult(), summary: 'Saved analysis', indexes: [], contracts: [] },
  };
  const session: ReviewSession = {
    id: 'session',
    title: 'Test',
    createdAt: run.startedAt,
    snapshots: [current],
    run: { ...run, id: 'latest' },
    history: [{ id: 'first', savedAt: run.startedAt, run, snapshots: [old], drafts: [] }],
  };
  store.saveSession(session);
  const call = (url: string, method: 'GET' | 'PUT' = 'GET', payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url: `/api/sessions/session/${url}`,
      payload,
      headers: { host: '127.0.0.1:4318' },
    });
  const response = await call('review-comparison?from=first');
  expect(response.statusCode).toBe(200);
  const view = response.json<ReviewRangeComparison>(),
    snap = view.snapshots[0];
  expect(view.to).toBe('current');
  expect(snap.headSha).toBe(current.headSha);
  expect(snap.mergeBase).toBe(old.headSha);
  expect(snap.reviewSnapshotId).toBe(current.id);
  expect(snap.files.find((f) => f.path === path)?.patch).toContain('+    order.toString();');
  expect(snap.files.find((f) => f.path === path)?.patch).not.toContain(
    '+    paymentClient.charge(order.id);',
  );
  expect(snap.files.some((f) => f.path.endsWith('V2__order_status.sql'))).toBe(false);
  expect(snap.files.find((f) => f.path.endsWith('Renamed.java'))?.status).toBe('D');
  expect(view.contracts[0].before?.info).toMatchObject({ version: '2.0.0' });
  expect(view.contracts[0].after?.info).toMatchObject({ version: '2.1.0' });
  const source = await call(
    `source?${new URLSearchParams({ repoId: f.repo.id, snapshotId: snap.id, side: 'base', path })}`,
  );
  expect(source.statusCode).toBe(200);
  expect(source.json().text).toBe(before);
  const head = await call(
    `source?${new URLSearchParams({ repoId: f.repo.id, snapshotId: snap.id, side: 'head', path })}`,
  );
  expect(head.json().text).toContain('order.toString();');
  const navigation = await call(
    `navigation-index?${new URLSearchParams({ snapshotId: snap.id, side: 'base' })}`,
  );
  expect(navigation.statusCode).toBe(200);
  expect(
    unpackIndex(navigation.json()).methods.find((m) => m.name === 'createOrder')!.evidence.side,
  ).toBe('base');
  const marked = await call('viewed-files', 'PUT', { snapshotId: snap.id, path, viewed: true });
  expect(marked.statusCode).toBe(200);
  const native = await call(`viewed-files?${new URLSearchParams({ snapshotIds: current.id })}`);
  expect(native.json()[0]).toMatchObject({ snapshotId: current.id, path, viewed: true });
  const full = (await call('review-comparison?from=base')).json<ReviewRangeComparison>();
  expect(full.snapshots[0].files.some((f) => f.path.endsWith('V2__order_status.sql'))).toBe(true);
  expect((await call('review-comparison?from=base&to=first')).statusCode).toBe(400);
  expect((await call('review-comparison?from=current')).statusCode).toBe(400);
  expect((await call('review-comparison?from=missing')).statusCode).toBe(400);
  expect(store.session('session')).toEqual(session);
  expect(analyzed).not.toHaveBeenCalled();
});
