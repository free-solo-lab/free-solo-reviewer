import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHub } from '../server/github';
import { createApp } from '../server/app';
import { FakeGitHub } from './fixtures';
import {
  emptyModelResult,
  type ReviewDiscussion,
  type ReviewSession,
  type Snapshot,
} from '../shared/model';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const root: ReviewDiscussion = {
  id: 'review:10',
  repoId: 'repo',
  body: 'Please fix this',
  author: 'reviewer',
  url: 'https://github.com/org/repo/pull/1#pullrequestreview-10',
  at: '',
  updatedAt: '',
};
it('uses the review node for reactions and preserves general reply linkage after reloading GitHub', async () => {
  const github = new GitHub();
  let posted = '';
  const api = vi.spyOn(github, 'api').mockImplementation(async (endpoint, options) => {
    if (endpoint === 'graphql') {
      const query = (options!.body as { query: string }).query;
      const groups = query.includes('removeReaction')
        ? []
        : [{ content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 2 } }];
      return {
        data: query.includes('mutation')
          ? {
              [query.includes('removeReaction') ? 'removeReaction' : 'addReaction']: {
                reactionGroups: groups,
              },
            }
          : { nodes: [{ id: 'review-node', reactionGroups: groups }] },
      };
    }
    if (endpoint.endsWith('/reviews/10')) return { node_id: 'review-node' };
    if (options?.method === 'POST') {
      posted = (options.body as { body: string }).body;
      return {
        id: 20,
        body: posted,
        html_url: 'https://github.com/org/repo/pull/1#issuecomment-20',
        user: { login: 'me' },
        created_at: '',
        updated_at: '',
      };
    }
    if (endpoint.includes('/reviews?'))
      return [
        {
          id: 10,
          node_id: 'review-node',
          body: root.body,
          html_url: root.url,
          user: { login: root.author },
        },
      ];
    if (endpoint.includes('/issues/1/comments?'))
      return [{ id: 20, body: posted, html_url: 'reply', user: { login: 'me' } }];
    return [];
  });
  expect(await github.reactDiscussion('org/repo', 1, root.id, '+1', true)).toEqual([
    { content: '+1', count: 2, viewerHasReacted: true },
  ]);
  expect(await github.reactDiscussion('org/repo', 1, root.id, '+1', false)).toEqual([]);
  expect(api.mock.calls.find(([e]) => e === 'graphql')?.[2]).toBe('org/repo');
  const reply = await github.replyDiscussion('org/repo', 1, root, 'Fixed it');
  expect(reply).toMatchObject({ id: 'comment:20', replyTo: root.id });
  expect(reply.body).toBe('Fixed it');
  expect(posted).toContain('@reviewer'); // GitHub readers still see whom it answers.
  const refreshed = await github.discussion('org/repo', 1);
  expect(refreshed.find((c) => c.id === reply.id)).toMatchObject({
    replyTo: root.id,
    body: reply.body,
  });
  expect(refreshed.find((c) => c.id === root.id)?.reactions?.[0].viewerHasReacted).toBe(true);
});
it('supports general review replies and reactions without changing or restarting analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'general-review-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const snapshot = { id: 'snap', repoId: 'repo', slug: 'org/repo', pr: { number: 1 } } as Snapshot;
  const reactDiscussion = vi.fn(async () => [
    { content: '+1' as const, count: 1, viewerHasReacted: true },
  ]);
  const replyDiscussion = vi.fn(async (_slug, _number, source, body) => ({
    ...root,
    id: 'comment:20',
    replyTo: source.id,
    body,
  }));
  const analyze = vi.fn();
  const { app, store } = createApp({
    dataDir: dir,
    github: Object.assign(new FakeGitHub(snapshot.pr!), { reactDiscussion, replyDiscussion }),
    provider: { id: 'never', analyze },
  });
  cleanup.push(() => app.close());
  const session: ReviewSession = {
    id: 'session',
    title: '',
    createdAt: '',
    snapshots: [snapshot],
    threadDiscussion: [root],
    run: {
      id: 'saved',
      sessionId: 'session',
      state: 'partial',
      version: '1',
      fingerprint: 'same',
      startedAt: '',
      events: [],
      result: { ...emptyModelResult(), indexes: [], contracts: [] },
    },
  };
  store.saveSession(session);
  const reaction = await app.inject({
    method: 'PUT',
    url: '/api/sessions/session/discussion/reactions',
    payload: { repoId: 'repo', commentId: root.id, content: '+1', active: true },
  });
  expect(reaction.statusCode, reaction.body).toBe(200);
  const reply = await app.inject({
    method: 'POST',
    url: '/api/sessions/session/discussion/replies',
    payload: { repoId: 'repo', rootId: root.id, body: 'Fixed' },
  });
  expect(reply.statusCode, reply.body).toBe(200);
  expect(store.session(session.id)?.threadDiscussion).toHaveLength(2);
  expect(store.session(session.id)?.run).toEqual(session.run);
  expect(analyze).not.toHaveBeenCalled();
});
