import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from './fixtures';
import { createApp } from '../server/app';
import { createSnapshot, createLocalSnapshot } from '../server/repository';
import { ensureReviewWorkflow, recordReviewCheckpoint } from '../shared/review-workflow';
import { selectedReviewRange } from '../shared/review-timeline';
import { ReviewComparisons } from '../server/review-comparison';
import { emptyModelResult, type ReviewSession } from '../shared/model';
import { git } from '../server/process';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('keeps human checkpoints separate from analysis and restores comparisons after restart', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const { app, store } = createApp({
    dataDir: join(f.root, 'workflow'),
    github: f.github,
    provider: { id: 'never', analyze: vi.fn() },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const session: ReviewSession = {
    id: 'human',
    title: 'Human',
    createdAt: '2026-01-01T00:00:00Z',
    snapshots: [snapshot],
    run: {
      id: 'technical-1',
      sessionId: 'human',
      state: 'complete',
      version: 'test',
      fingerprint: 'test',
      startedAt: '2026-01-01T00:01:00Z',
      events: [],
      result: { ...emptyModelResult(), summary: 'Saved', contracts: [], indexes: [] },
    },
  };
  ensureReviewWorkflow(session);
  expect(selectedReviewRange(session).from.id).toBe('base');
  recordReviewCheckpoint(session, snapshot.repoId, 'accepted-packet', 'local', ['c']);
  const checkpoint = session.workflow!.checkpoints[0];
  // The review covers the current code, so it is no stage until new commits arrive.
  expect(selectedReviewRange(session).points.map((p) => p.id)).toEqual(['base', 'current']);
  session.history = [
    {
      id: session.run!.id,
      savedAt: '2026-01-01T00:02:00Z',
      run: session.run!,
      snapshots: [snapshot],
      drafts: [],
    },
  ];
  session.run = { ...session.run!, id: 'technical-2' };
  store.saveSession(session);
  expect(selectedReviewRange(store.session(session.id)!).from.id).toBe('base');
  const view = await new ReviewComparisons(store).read(session, 'base');
  expect(
    new ReviewComparisons(store).snapshot(store.session(session.id)!, view.snapshots[0].id)?.id,
  ).toBe(view.snapshots[0].id);
  expect(
    recordReviewCheckpoint(session, snapshot.repoId, 'accepted-packet', 'local', ['c']).id,
  ).toBe(checkpoint.id);
  expect(session.workflow!.checkpoints).toHaveLength(1);
});
it('ignores empty commits, discussion and remote approvals without invoking analysis or moving the human checkpoint', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const analyze = vi.fn();
  const { app, store } = createApp({
    dataDir: join(f.root, 'source-only'),
    github: f.github,
    provider: { id: 'never', analyze },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const session: ReviewSession = {
    id: 'source',
    title: 'Source',
    createdAt: '2026-01-01T00:00:00Z',
    snapshots: [snapshot],
    run: null,
  };
  recordReviewCheckpoint(session, f.repo.id, 'sent', 'local', []);
  store.saveSession(session);
  await git(f.repo.path, ['commit', '--allow-empty', '-m', 'Empty metadata commit']);
  const sha = (await git(f.repo.path, ['rev-parse', 'HEAD'])).trim();
  await git(f.repo.path, ['push', 'origin', `${sha}:refs/pull/12/head`]);
  f.github.pr = { ...f.github.pr, headRefOid: sha };
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/refresh`,
    payload: { analyze: true },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<ReviewSession>().run).toBeNull();
  expect(response.json<ReviewSession>().history).toBeUndefined();
  expect(analyze).not.toHaveBeenCalled();
  expect(response.json<ReviewSession>().workflow!.checkpoints.map((c) => c.id)).toEqual([
    session.workflow!.checkpoints[0].id,
  ]);
  expect(selectedReviewRange(response.json()).from.id).toBe('base');
  Object.assign(f.github, {
    remoteState: vi.fn(async () => ({ state: 'merged', headSha: sha, decision: 'approved' })),
  });
  const remote = await app.inject({
    method: 'GET',
    url: `/api/sessions/${session.id}/remote-state`,
  });
  expect(remote.statusCode, remote.body).toBe(200);
  expect(remote.json().workflow.remote[0]).toMatchObject({ state: 'merged', decision: 'approved' });
  expect(analyze).not.toHaveBeenCalled();
});
it('preserves draft text and original evidence when changes make its anchor ambiguous', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const { app, store } = createApp({ dataDir: join(f.root, 'anchors'), github: f.github });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  await writeFile(join(f.repo.path, 'note.txt'), 'original\n');
  const snap = await createLocalSnapshot(f.repo, 'HEAD', join(f.root, 'snapshots'));
  const session: ReviewSession = {
    id: 'anchors',
    title: 'Anchors',
    createdAt: '2026-01-01',
    snapshots: [snap],
    run: null,
  };
  store.saveSession(session);
  const evidence = {
    repoId: f.repo.id,
    side: 'head' as const,
    path: 'note.txt',
    startLine: 1,
    endLine: 1,
  };
  store.saveDraft({
    sessionId: session.id,
    snapshotId: snap.id,
    headSha: snap.headSha,
    state: 'draft',
    body: '',
    action: 'COMMENT',
    attempt: null,
    submission: null,
    comments: [{ id: 'c', body: 'Keep my exact text', selected: true, evidence }],
  });
  await writeFile(join(f.repo.path, 'note.txt'), 'different\n');
  const refreshed = await app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/refresh`,
    payload: {},
  });
  expect(refreshed.statusCode, refreshed.body).toBe(200);
  const comment = store
    .drafts(session.id)
    .find((d) => d.snapshotId === refreshed.json().snapshots[0].id)!.comments[0];
  expect(comment).toMatchObject({
    body: 'Keep my exact text',
    evidence,
    origin: { snapshotId: snap.id, evidence },
    outdated: true,
    selected: false,
  });
});
it('refreshes a completed PR fix batch once into unpublished source and keeps the fix dialogue across the new snapshot', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const calls: { threadId?: string; apply: boolean }[] = [];
  const analyze = vi.fn(async () => emptyModelResult());
  const { app, store, fixes } = createApp({
    dataDir: join(f.root, 'fix-pr'),
    github: f.github,
    provider: { id: 'tiny', analyze },
    fixProvider: {
      run: async (input, _signal, emit) => {
        calls.push({ threadId: input.threadId, apply: input.apply });
        emit({ type: 'thread.started', thread_id: 'persistent-fix-thread' });
        if (input.apply)
          await writeFile(join(f.repo.path, 'reviewed.txt'), 'Fixed in the working folder\n');
        emit({
          type: 'item.completed',
          item: { id: 'result', type: 'agent_message', text: input.apply ? 'Done' : 'Plan' },
        });
      },
    },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const snap = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const session: ReviewSession = {
    id: 'pr-fixes',
    title: 'PR fixes',
    createdAt: '2026-01-01',
    snapshots: [snap],
    run: null,
  };
  store.saveSession(session);
  store.saveDraft({
    sessionId: session.id,
    snapshotId: snap.id,
    headSha: snap.headSha,
    state: 'draft',
    body: '',
    action: 'COMMENT',
    attempt: null,
    submission: null,
    comments: [
      { id: 'fix', body: 'Fix reviewed text', evidence: null, forCodex: true, selected: false },
    ],
  });
  const post = (action: string) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/fix-chat`,
      payload: { repoId: f.repo.id, action },
    });
  expect((await post('plan')).statusCode).toBe(200);
  await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
  expect(analyze).not.toHaveBeenCalled();
  expect((await post('apply')).statusCode).toBe(200);
  // The refresh snapshots and indexes real Git repositories; a busy machine needs more than a second.
  await vi.waitFor(() => expect(store.fixChat(session.id)?.postFix?.state).toBe('complete'), {
    timeout: 10_000,
  });
  await vi.waitFor(() => expect(store.session(session.id)?.run?.state).not.toBe('running'), {
    timeout: 10_000,
  });
  const updated = store.session(session.id)!;
  expect(updated.snapshots[0].working).toBeDefined();
  expect(updated.snapshots[0].pr?.number).toBe(12);
  expect(updated.snapshots[0].id).not.toBe(snap.id);
  expect(updated.workflow!.fixUpdates).toMatchObject({
    [store.fixChat(session.id)!.turnId]: { state: 'complete' },
  });
  expect(calls[1].threadId).toBe('persistent-fix-thread');
  expect(fixes.isRunning(session.id)).toBe(false);
  expect(analyze).toHaveBeenCalledTimes(1); // Initial manual review: only the fix delta, no original PR SQL/tests.
  const count = analyze.mock.calls.length;
  const draft = store.drafts(session.id).find((d) => d.snapshotId === updated.snapshots[0].id)!;
  store.saveDraft({ ...draft, body: 'Next question' });
  expect((await post('plan')).statusCode).toBe(200);
  await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
  expect(calls.at(-1)?.threadId).toBe('persistent-fix-thread');
  expect(analyze).toHaveBeenCalledTimes(count);
  // Simulate a restart after the server saved its update but before the chat got its ACK.
  const completeChat = store.fixChat(session.id)!;
  const completedTurn = Object.entries(store.session(session.id)!.workflow!.fixUpdates!)[0][0];
  store.saveFixChat({
    ...completeChat,
    state: 'complete',
    postFix: { turnId: completedTurn, state: 'pending' },
  });
  const ids = store.session(session.id)!.workflow!.checkpoints.map((c) => c.id);
  await app.close();
  const restarted = createApp({
    dataDir: join(f.root, 'fix-pr'),
    github: f.github,
    provider: { id: 'tiny', analyze },
  });
  cleanup.push(() => restarted.app.close());
  await restarted.app.ready();
  await vi.waitFor(() =>
    expect(restarted.store.fixChat(session.id)?.postFix?.state).toBe('complete'),
  );
  expect(restarted.store.session(session.id)!.workflow!.checkpoints.map((c) => c.id)).toEqual(ids);
  expect(restarted.store.fixChat(session.id)?.contexts?.[f.repo.id].threadId).toBe(
    'persistent-fix-thread',
  );
  const acknowledged = restarted.store.fixChat(session.id)!;
  restarted.store.saveFixChat({
    ...acknowledged,
    postFix: { turnId: completedTurn, state: 'failed', error: 'Lost acknowledgement' },
  });
  const retry = await restarted.app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/fix-chat/retry-update`,
    payload: {},
  });
  expect(retry.statusCode, retry.body).toBe(200);
  expect(restarted.store.fixChat(session.id)?.postFix?.state).toBe('complete');
  expect(analyze).toHaveBeenCalledTimes(count);
});
