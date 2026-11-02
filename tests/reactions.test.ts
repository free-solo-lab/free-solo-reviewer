import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHub } from '../server/github';
import * as processTools from '../server/process';
import { createApp } from '../server/app';
import { FakeGitHub } from './fixtures';
import {
  emptyModelResult,
  type ReviewDiscussion,
  type ReviewSession,
  type Snapshot,
} from '../shared/model';
import type { ReactionContent } from '../shared/reactions';
import { DiscussionThread } from '../web/DiscussionThread';
import { authorColors } from '../web/author-colors';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
type Row = { id: number; content: ReactionContent; user: { login: string } | null };
class StubGitHub extends GitHub {
  calls: { endpoint: string; options?: { method: string; body: unknown } }[] = [];
  constructor(public rows: Row[]) {
    super();
  }
  override async api<T>(endpoint: string, options?: { method: string; body: unknown }): Promise<T> {
    this.calls.push({ endpoint, options });
    if (endpoint === 'user') return { login: 'Reviewer' } as T;
    if (options?.method === 'POST') {
      const row = {
        id: 999,
        content: (options.body as { content: ReactionContent }).content,
        user: { login: 'reviewer' },
      };
      this.rows.push(row);
      return row as T;
    }
    if (options?.method === 'DELETE') {
      this.rows = this.rows.filter((row) => row.id !== Number(endpoint.split('/').at(-1)));
      return undefined as T;
    }
    const page = Number(
      new URL(`https://api.github.com/${endpoint}`).searchParams.get('page') ?? '1',
    );
    return this.rows.slice((page - 1) * 100, page * 100) as T;
  }
}
const root: ReviewDiscussion = {
  id: 'inline:10',
  repoId: 'repo',
  author: 'octo-reviewer',
  body: 'Question',
  url: 'https://github.com/example',
  at: '2026-10-19T10:00:00Z',
  updatedAt: '2026-10-19T10:00:00Z',
};
describe('GitHub comment reactions and author colors', () => {
  it('adds reactions idempotently and only removes the signed-in user’s reaction', async () => {
    const github = new StubGitHub([{ id: 1, content: '+1', user: { login: 'other' } }]);
    expect(await github.setCommentReaction('org/repo', 10, '+1', true)).toEqual([
      { content: '+1', count: 2, viewerHasReacted: true },
    ]);
    await github.setCommentReaction('org/repo', 10, '+1', true);
    expect(github.calls.filter((call) => call.options?.method === 'POST')).toHaveLength(1);
    expect(await github.setCommentReaction('org/repo', 10, '+1', false)).toEqual([
      { content: '+1', count: 1, viewerHasReacted: false },
    ]);
    const deleted = github.calls.filter((call) => call.options?.method === 'DELETE');
    expect(deleted.map((call) => call.endpoint)).toEqual([
      'repos/org/repo/pulls/comments/10/reactions/999',
    ]);
    expect(github.rows).toEqual([{ id: 1, content: '+1', user: { login: 'other' } }]);
    await github.setCommentReaction('org/repo', 10, '+1', false);
    expect(github.calls.filter((call) => call.options?.method === 'DELETE')).toHaveLength(1);
  });
  it('finds the viewer on later pages and handles an empty HTTP 204 response', async () => {
    const rows: Row[] = Array.from({ length: 100 }, (_, id) => ({
      id,
      content: 'heart',
      user: { login: `other-${id}` },
    }));
    rows.push({ id: 101, content: 'heart', user: { login: 'reviewer' } });
    const github = new StubGitHub(rows);
    expect(await github.commentReactions('org/repo', 10)).toEqual([
      { content: 'heart', count: 101, viewerHasReacted: true },
    ]);
    await github.setCommentReaction('org/repo', 10, 'heart', false);
    expect(github.rows).toHaveLength(100);
    const command = vi
      .spyOn(processTools, 'command')
      .mockResolvedValue('HTTP/2.0 204 No Content\r\nDate: now\r\n\r\n');
    expect(
      await new GitHub().api('repos/org/repo/pulls/comments/10/reactions/101', {
        method: 'DELETE',
        body: undefined,
      }),
    ).toBeUndefined();
    expect(command.mock.calls[0][1]).not.toContain('--input');
    expect(command.mock.calls[0][2]?.input).toBeUndefined();
  });
  it('gives authors distinct consistent colors and shows existing own reactions on questions and replies', () => {
    expect(authorColors('octo-reviewer')).toEqual(authorColors('OCTO-REVIEWER'));
    expect(authorColors('octo-reviewer')).not.toEqual(authorColors('PrAuthor'));
    const html = renderToStaticMarkup(
      React.createElement(DiscussionThread, {
        sessionId: 'session',
        thread: {
          root: { ...root, reactions: [{ content: '+1', count: 2, viewerHasReacted: true }] },
          replies: [
            {
              ...root,
              id: 'inline:11',
              author: 'PrAuthor',
              replyTo: root.id,
              reactions: [{ content: 'heart', count: 1, viewerHasReacted: false }],
            },
          ],
        },
        async onReact() {},
      }),
    );
    expect(html).toContain('data-author="octo-reviewer"');
    expect(html).toContain('data-author="PrAuthor"');
    expect(html.match(/aria-label="Добавить реакцию"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Нравится: 2 · ваша реакция"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Сердце: 1"');
  });
  it('validates the comment and reaction before writing, persists updates and leaves review analysis intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-reactions-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const snap = {
      id: 'snap',
      repoId: 'repo',
      repoName: 'Repo',
      slug: 'org/repo',
      pr: { number: 1 },
    } as unknown as Snapshot;
    let calls = 0;
    const gateway = Object.assign(new FakeGitHub(snap.pr!), {
      async setCommentReaction(
        _slug: string,
        id: number,
        content: ReactionContent,
        active: boolean,
      ) {
        calls++;
        expect([10, 11]).toContain(id);
        return active ? [{ content, count: 1, viewerHasReacted: true }] : [];
      },
    });
    const { app, store } = createApp({ dataDir: dir, github: gateway });
    cleanup.push(() => app.close());
    const session: ReviewSession = {
      id: 'session',
      title: '',
      createdAt: '',
      snapshots: [snap],
      discussion: [root],
      threadDiscussion: [root, { ...root, id: 'inline:11', replyTo: root.id }],
      run: {
        id: 'run',
        sessionId: 'session',
        version: '1',
        fingerprint: 'keep',
        state: 'complete',
        startedAt: '',
        events: [],
        result: { ...emptyModelResult(), indexes: [], contracts: [] },
      },
    };
    store.saveSession(session);
    const request = (payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: '/api/sessions/session/discussion/reactions',
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const payload = { repoId: 'repo', commentId: 'inline:10', content: '+1', active: true };
    expect((await request(payload)).statusCode).toBe(200);
    expect(store.session('session')!.threadDiscussion![0].reactions).toEqual([
      { content: '+1', count: 1, viewerHasReacted: true },
    ]);
    expect((await request({ ...payload, commentId: 'inline:11' })).statusCode).toBe(200);
    expect((await request({ ...payload, active: false })).statusCode).toBe(200);
    expect((await request({ ...payload, content: 'invalid' })).statusCode).toBe(400);
    expect((await request({ ...payload, repoId: 'other' })).statusCode).toBe(404);
    expect((await request({ ...payload, commentId: 'inline:999' })).statusCode).toBe(404);
    expect((await request({ ...payload, commentId: 'review:10' })).statusCode).toBe(404);
    expect(calls).toBe(3);
    expect(store.session('session')!.run).toEqual(session.run);
    expect(store.session('session')!.discussion).toEqual([root]);
  });
});
