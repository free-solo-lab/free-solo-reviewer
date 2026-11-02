import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fixture } from './fixtures';
import { createApp } from '../server/app';
import { createLocalSnapshot } from '../server/repository';
import { git } from '../server/process';
import { recordReviewCheckpoint } from '../shared/review-workflow';
import { selectedReviewRange } from '../shared/review-timeline';
import { emptyModelResult, type PullRequest, type ReviewSession } from '../shared/model';
import type { PullRequestPreview } from '../shared/pull-request-workflow';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('publishes only captured reviewed paths, recovers an uncertain request without duplicates and preserves the local project', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const analyze = vi.fn();
  const { app, store } = createApp({
    dataDir: join(f.root, 'workflow'),
    github: f.github,
    provider: { id: 'never', analyze },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const beforeHead = (await git(f.repo.path, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(f.repo.path, 'reviewed.txt'), 'Reviewed change\n');
  const snapshot = await createLocalSnapshot(f.repo, 'main', join(f.root, 'snapshots'));
  const session: ReviewSession = {
    id: 'local-pr',
    title: 'Publish reviewed changes',
    createdAt: '2026-01-01',
    snapshots: [snapshot],
    run: {
      id: 'analysis',
      sessionId: 'local-pr',
      state: 'complete',
      version: 'test',
      fingerprint: 'test',
      startedAt: '2026-01-01',
      events: [],
      result: { ...emptyModelResult(), summary: 'Semantic summary', indexes: [], contracts: [] },
    },
  };
  recordReviewCheckpoint(session, f.repo.id, 'packet', 'local', ['c']);
  store.saveSession(session);
  store.saveDraft({
    sessionId: session.id,
    snapshotId: snapshot.id,
    headSha: snapshot.headSha,
    state: 'draft',
    action: 'COMMENT',
    body: 'Local notes',
    comments: [{ id: 'c', body: 'Keep discussion', evidence: null, selected: true }],
    attempt: null,
    submission: null,
  });
  const prepare = await app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/pull-request/prepare`,
    payload: { repoId: f.repo.id },
  });
  expect(prepare.statusCode, prepare.body).toBe(200);
  const preview = prepare.json<PullRequestPreview>();
  expect(preview.files).toContain('reviewed.txt');
  await writeFile(join(f.repo.path, 'unrelated.txt'), 'Never publish this\n');
  await git(f.repo.path, ['add', 'unrelated.txt']);
  const input = { previewId: preview.id, title: preview.title, body: preview.body };
  const create = () =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/pull-request/create`,
      payload: input,
    });
  Object.assign(f.github, { findPullRequest: async () => undefined, createPullRequest: vi.fn() });
  expect((await create()).statusCode).toBe(409); // Changes since preview cannot slip into a publication.
  await git(f.repo.path, ['reset', '--', 'unrelated.txt']);
  // Ignored/untracked files outside the allowed source catalog are not part of the publication.
  await writeFile(join(f.repo.path, 'unrelated.bin'), 'Private staged data');
  await git(f.repo.path, ['add', 'unrelated.bin']);
  const { rm } = await import('node:fs/promises');
  await rm(join(f.repo.path, 'unrelated.txt'));
  let remote: PullRequest | undefined;
  const find = vi.fn(async () => remote);
  const publish = vi.fn(
    async (_slug: string, data: { head: string; base: string; title: string; body: string }) => {
      const sha = store.pullRequestPreview(preview.id)!.commit!;
      await git(f.repo.path, ['push', 'origin', `${sha}:refs/pull/13/head`]);
      remote = {
        ...f.pr,
        number: 13,
        headRefOid: sha,
        headRefName: data.head,
        baseRefName: data.base,
        title: data.title,
        body: data.body,
      };
      f.github.pr = remote;
      throw new Error('Response lost after GitHub accepted the PR');
    },
  );
  Object.assign(f.github, { findPullRequest: find, createPullRequest: publish });
  const uncertain = await create();
  expect(uncertain.statusCode).toBeGreaterThanOrEqual(400);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(store.pullRequestPreview(preview.id)?.state).toBe('uncertain');
  const recovered = await create();
  expect(recovered.statusCode, recovered.body).toBe(200);
  expect(publish).toHaveBeenCalledTimes(1);
  const updated = recovered.json<{ session: ReviewSession }>().session;
  expect(updated.id).toBe(session.id);
  expect(updated.snapshots[0].pr?.number).toBe(13);
  expect(updated.snapshots[0].reviewLineage).toBe(snapshot.reviewLineage);
  expect(updated.run?.id).toBe('analysis');
  expect(selectedReviewRange(updated).from.id).toBe(session.workflow!.checkpoints[0].id);
  expect(
    store.drafts(session.id).find((d) => d.snapshotId === updated.snapshots[0].id)?.comments[0]
      .body,
  ).toBe('Keep discussion');
  const commit = store.pullRequestPreview(preview.id)!.commit!;
  expect(
    (await git(f.repo.path, ['ls-tree', '-r', '--name-only', commit])).split('\n'),
  ).not.toContain('unrelated.bin');
  expect(await readFile(join(f.repo.path, 'unrelated.bin'), 'utf8')).toBe('Private staged data');
  expect((await git(f.repo.path, ['diff', '--cached', '--name-only'])).trim()).toBe(
    'unrelated.bin',
  );
  expect((await git(f.repo.path, ['rev-parse', 'HEAD'])).trim()).toBe(beforeHead);
  const repeated = await create();
  expect(repeated.statusCode, repeated.body).toBe(200);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(analyze).not.toHaveBeenCalled();
  const comparison = await app.inject({
    method: 'GET',
    url: `/api/sessions/${session.id}/review-comparison?from=${encodeURIComponent(session.workflow!.checkpoints[0].id)}`,
  });
  expect(comparison.statusCode, comparison.body).toBe(200);
  expect(comparison.json().snapshots[0].files).toEqual([]);
  expect(updated.snapshots[0].workspaceHead).toBe(beforeHead);
  const { readWorkingFile, writeWorkingFile } = await import('../server/working-files');
  const loaded = await readWorkingFile(f.repo, updated.snapshots[0], 'reviewed.txt');
  const edit = await writeWorkingFile(
    f.repo,
    updated.snapshots[0],
    'reviewed.txt',
    loaded.hash,
    'Own edit after publication\n',
  );
  await writeWorkingFile(
    f.repo,
    updated.snapshots[0],
    'reviewed.txt',
    edit.hash,
    'Second own edit after publication\n',
  );
  expect(await readFile(join(f.repo.path, 'reviewed.txt'), 'utf8')).toBe(
    'Second own edit after publication\n',
  );
});
it('publishes an unpublished fix to the same PR without another analysis or another PR', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const analyze = vi.fn();
  await git(f.repo.path, ['push', 'origin', `${f.pr.headRefOid}:refs/heads/${f.pr.headRefName}`]);
  // The fake GitHub follows the remote branch and updates its PR ref, just as GitHub does.
  Object.assign(f.github, {
    createPullRequest: vi.fn(),
    findPullRequest: vi.fn(),
    pull: async () => {
      const output = await git(f.repo.path, [
        'ls-remote',
        'origin',
        `refs/heads/${f.pr.headRefName}`,
      ]);
      const sha = output.trim().split(/\s+/)[0];
      if (sha) {
        f.github.pr = { ...f.github.pr, headRefOid: sha };
        await git(f.repo.path, ['push', 'origin', `${sha}:refs/pull/12/head`]);
      }
      return f.github.pr;
    },
  });
  const { app, store } = createApp({
    dataDir: join(f.root, 'publish-fix'),
    github: f.github,
    provider: { id: 'never', analyze },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const { createSnapshot } = await import('../server/repository');
  const native = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  await writeFile(join(f.repo.path, 'fixed.txt'), 'Reviewed fix\n');
  const local = await createLocalSnapshot(f.repo, 'main', join(f.root, 'snapshots'));
  const { local: working, ...source } = local;
  const session: ReviewSession = {
    id: 'existing-pr',
    title: 'Existing PR',
    createdAt: '2026-01-01',
    snapshots: [{ ...source, working, pr: f.pr }],
    run: null,
  };
  recordReviewCheckpoint(session, f.repo.id, 'before-fix', 'local', []);
  store.saveSession(session);
  const prepare = await app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/pull-request/prepare`,
    payload: { repoId: f.repo.id },
  });
  expect(prepare.statusCode, prepare.body).toBe(200);
  const preview = prepare.json<PullRequestPreview>();
  expect(preview.existingPr).toBe(12);
  expect(preview.files).toEqual(['fixed.txt']);
  expect(preview.parent).toBe(native.headSha);
  const created = await app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/pull-request/create`,
    payload: { previewId: preview.id, title: preview.title, body: preview.body },
  });
  expect(created.statusCode, created.body).toBe(200);
  const updated = created.json<{ session: ReviewSession }>().session;
  expect(updated.snapshots[0].pr?.number).toBe(12);
  expect(updated.snapshots[0].working).toBeUndefined();
  expect(updated.snapshots[0].contentHash).toBe(source.contentHash);
  expect(analyze).not.toHaveBeenCalled();
  expect(
    (f.github as unknown as { createPullRequest: ReturnType<typeof vi.fn> }).createPullRequest,
  ).not.toHaveBeenCalled();
  expect(
    (
      await git(f.repo.path, ['show', `${store.pullRequestPreview(preview.id)!.commit}:fixed.txt`])
    ).trim(),
  ).toBe('Reviewed fix');
});
