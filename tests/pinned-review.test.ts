import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../server/process';
import { connectRepository, createLocalSnapshot, readSource } from '../server/repository';
import { createApp } from '../server/app';
import { restoreReviewBranch } from '../shared/review-branch';
import type { ReviewSession } from '../shared/model';
import { fixture as remoteFixture } from './fixtures';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
it('keeps two branch diffs readable and refreshes the pinned branch without checking it out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinned-review-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.name', 'Test']);
  await git(path, ['config', 'user.email', 'test@example.com']);
  const file = join(path, 'Handler.java');
  await writeFile(file, 'class Handler { int run() { return 1; } }');
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'base']);
  await git(path, ['checkout', '-b', 'protocols']);
  await writeFile(file, 'class Handler { int run() { return 2; } }');
  await git(path, ['commit', '-am', 'protocols']);
  const repo = await connectRepository(path),
    snap = await createLocalSnapshot(repo, 'main', join(root, 'snapshots'), false);
  await git(path, ['checkout', '-b', 'protocols-impl']);
  await writeFile(file, 'class Handler { int run() { return 3; } }');
  await git(path, ['commit', '-am', 'impl']);
  const impl = await createLocalSnapshot(repo, 'protocols', join(root, 'snapshots'), false);
  const pinned = await createLocalSnapshot(
    repo,
    'main',
    join(root, 'snapshots'),
    false,
    snap.local,
  );
  expect(await readSource(pinned, { side: 'head', path: 'Handler.java' })).toContain('return 2');
  expect(await readSource(impl, { side: 'head', path: 'Handler.java' })).toContain('return 3');
  expect((await git(path, ['branch', '--show-current'])).trim()).toBe('protocols-impl');
  expect(await readFile(file, 'utf8')).toContain('return 3');
  const analyze = vi.fn();
  const { app, store } = createApp({
    dataDir: join(root, 'app'),
    provider: { id: 'never', analyze },
  });
  cleanup.push(() => app.close());
  store.saveRepository(repo);
  store.saveSession({
    id: 's',
    title: 'Protocols',
    createdAt: new Date().toISOString(),
    snapshots: [snap],
    run: null,
  });
  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/sessions/s/refresh',
    payload: { analyze: false },
  });
  expect(refreshed.statusCode, refreshed.body).toBe(200);
  expect(store.session('s')!.snapshots[0].local?.branchName).toBe('protocols');
  const edit = await app.inject({
    method: 'GET',
    url: `/api/sessions/s/working-file?repoId=${repo.id}&path=Handler.java`,
  });
  expect(edit.statusCode).toBe(409);
  expect(await readFile(file, 'utf8')).toContain('return 3');
  const renamed = await app.inject({
    method: 'PATCH',
    url: '/api/sessions/s',
    payload: { title: '  Protocol review  ' },
  });
  expect(renamed.statusCode).toBe(200);
  expect(store.session('s')!.title).toBe('Protocol review');
  expect(analyze).not.toHaveBeenCalled();
});
it('recovers the original branch and its analysis without deleting the other saved branch', () => {
  const snap = (id: string, branchName: string) => ({ id, repoId: 'r', local: { branchName } });
  const old = {
    id: 'old',
    savedAt: '2026-01-01',
    snapshots: [snap('proto', 'protocols')],
    run: { id: 'analysis' },
    drafts: [],
  };
  const s = {
    id: 's',
    createdAt: '2026-01-01',
    snapshots: [snap('impl', 'protocols-impl')],
    run: { state: 'cancelled' },
    history: [old],
    workflow: {
      version: 1,
      initial: { at: 'now', snapshots: [snap('impl', 'protocols-impl')] },
      versions: [],
      checkpoints: [],
    },
  } as unknown as ReviewSession;
  expect(restoreReviewBranch(s)).toBe(true);
  expect(s.snapshots[0].id).toBe('proto');
  expect(s.run?.id).toBe('analysis');
  expect(s.workflow!.versions.some((v) => v.id === 'impl')).toBe(true);
  expect(s.history).toHaveLength(1);
});
it('discovers the original branch PR and its comments while another branch is checked out, without analysis', async () => {
  const f = await remoteFixture();
  cleanup.push(f.cleanup);
  const snap = await createLocalSnapshot(f.repo, 'HEAD', join(f.root, 'local'), false);
  await git(f.repo.path, ['checkout', '-b', 'implementation-review']);
  const findPullRequest = vi.fn().mockResolvedValue(f.github.pr);
  Object.assign(f.github, { findPullRequest });
  f.github.comments.push({
    id: 'reply',
    body: 'Please check this change',
    author: 'author',
    url: 'https://example.com/comment',
    at: '2026-11-02T01:00:00Z',
    updatedAt: '2026-11-02T01:00:00Z',
  });
  const analyze = vi.fn();
  const { app, store } = createApp({
    dataDir: join(f.root, 'linked-app'),
    github: f.github,
    provider: { id: 'never', analyze },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  store.saveSession({
    id: 'linked',
    title: 'Protocols',
    createdAt: '2026-11-01',
    snapshots: [snap],
    run: null,
  });
  const result = await app.inject({ method: 'GET', url: '/api/sessions/linked/remote-state' });
  expect(result.statusCode, result.body).toBe(200);
  expect(findPullRequest).toHaveBeenCalledWith(f.repo.slug, snap.local!.branchName);
  expect(store.session('linked')!.snapshots[0].pr?.number).toBe(f.github.pr.number);
  expect(store.session('linked')!.threadDiscussion?.some((c) => c.id === 'reply')).toBe(true);
  expect((await git(f.repo.path, ['branch', '--show-current'])).trim()).toBe(
    'implementation-review',
  );
  expect(analyze).not.toHaveBeenCalled();
});
