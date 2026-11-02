import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceCode } from '../web/components';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceDiscussions, discussionAtLine, reviewThreads } from '../shared/discussion-threads';
import type {
  Evidence,
  ReviewDiscussion,
  ReviewDraft,
  ReviewSession,
  Snapshot,
} from '../shared/model';
import { emptyModelResult } from '../shared/model';
import { Discussions } from '../server/discussion';
import { GitHub } from '../server/github';
import { FakeGitHub } from './fixtures';
import { createApp } from '../server/app';

const root: ReviewDiscussion = {
  id: 'inline:10',
  repoId: 'repo',
  author: 'me',
  body: 'Why?',
  at: '2026-10-19T10:00:00Z',
  updatedAt: '2026-10-19T10:00:00Z',
  url: 'https://github.com/org/repo/pull/1#discussion_r10',
  reviewId: 42,
  originalCommitId: 'old',
  commitId: 'old',
  location: { path: 'Service.java', side: 'head', line: 20, originalLine: 10 },
};
const origin: Evidence = {
  repoId: 'repo',
  path: 'Service.java',
  side: 'head',
  startLine: 1,
  endLine: 1,
};
const snap = {
  id: 'snap',
  repoId: 'repo',
  repoName: 'Repo',
  slug: 'org/repo',
  headSha: 'new',
  headFiles: ['Service.java'],
  files: [],
  pr: { number: 1 },
} as unknown as Snapshot;
const response = {
  ...root,
  id: 'inline:11',
  author: 'author',
  body: 'Fixed',
  replyTo: root.id,
  location: undefined,
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe('GitHub inline discussion threads', () => {
  it('collects the threads of every file of a review with their replies, by file and line', () => {
    const other = {
      ...root,
      id: 'inline:20',
      body: 'Rename',
      location: { ...root.location!, path: 'Api.java', line: 5 },
    };
    const outdated = {
      ...root,
      id: 'inline:30',
      body: 'Old',
      location: { ...root.location!, line: null, originalLine: 3 },
    };
    const general = { ...root, id: 'comment:1', location: undefined };
    const threads = reviewThreads([root, response, other, outdated, general], snap);
    expect(threads.map((thread) => thread.root.id)).toEqual([
      'inline:20',
      'inline:30',
      'inline:10',
    ]);
    expect(threads[2].replies.map((reply) => reply.id)).toEqual(['inline:11']);
    expect(threads[1].evidence).toBeUndefined();
    expect(reviewThreads([root], { ...snap, repoId: 'elsewhere' })).toEqual([]);
  });
  it('renders the reply under its question inside code and retains a reply editor', () => {
    const threads = sourceDiscussions([root, response], snap, origin, true);
    const html = renderToStaticMarkup(
      React.createElement(SourceCode, {
        text: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
        evidence: origin,
        onSelect() {},
        discussions: threads,
        discussionSessionId: 'session',
        async onDiscussionReply() {},
      }),
    );
    expect(html.indexOf('Why?')).toBeLessThan(html.indexOf('Fixed'));
    expect(html).toContain('Ответить в ветке');
    expect(html).toContain('Обсуждение GitHub');
  });

  it('places replies under the original question, maps historical lines and avoids repo collisions', () => {
    const draft = {
      submission: { id: 42 },
      comments: [
        {
          id: 'local',
          body: 'Why?',
          selected: true,
          evidence: { ...origin, startLine: 10, endLine: 10 },
        },
      ],
    } as ReviewDraft;
    const comments = [
      root,
      response,
      { ...response, id: 'inline:12', replyTo: response.id, body: 'Thanks' },
      { ...response, repoId: 'other', body: 'Wrong repo' },
    ];
    const current = sourceDiscussions(comments, snap, origin, true, [draft, draft]);
    expect(current).toHaveLength(1);
    expect(current[0].replies.map((reply) => reply.body)).toEqual(['Fixed', 'Thanks']);
    expect(current[0].localCommentId).toBe('local');
    const continued = {
      ...draft,
      submission: null,
      comments: [],
      published: [
        {
          snapshotId: snap.id,
          headSha: snap.headSha,
          action: 'COMMENT' as const,
          body: '',
          comments: draft.comments,
          submission: { id: 42, url: 'https://github.com/review/42', at: '2026-10-27T00:00:00Z' },
        },
      ],
    };
    expect(sourceDiscussions(comments, snap, origin, true, [continued])[0].localCommentId).toBe(
      'local',
    );
    expect(discussionAtLine(current, { ...origin, startLine: 20 })).toHaveLength(1);
    const historical = sourceDiscussions(comments, { ...snap, headSha: 'old' }, origin, false);
    expect(historical[0].evidence?.endLine).toBe(10);
    expect(
      sourceDiscussions(
        [{ ...root, location: { ...root.location!, line: null } }, response],
        snap,
        origin,
        true,
      )[0].evidence,
    ).toBeUndefined();
    expect(
      sourceDiscussions(comments, { ...snap, headSha: 'unrelated' }, origin, false)[0].evidence,
    ).toBeUndefined();
  });
  it('retains inline GitHub location metadata and sends a reply to the root endpoint', async () => {
    const calls: { endpoint: string; options?: unknown }[] = [];
    class Stub extends GitHub {
      override async api<T>(
        endpoint: string,
        options?: { method: string; body: unknown },
      ): Promise<T> {
        calls.push({ endpoint, options });
        const row = {
          id: 10,
          body: 'Why?',
          html_url: 'https://github.com/example',
          user: { login: 'me' },
          created_at: root.at,
          updated_at: root.at,
          pull_request_review_id: 42,
          path: 'Service.java',
          side: 'RIGHT',
          line: 20,
          original_line: 10,
          commit_id: 'old',
          original_commit_id: 'old',
          diff_hunk: '@@ -1,2 +1,2 @@\n-old()\n+run()',
        };
        return (
          options
            ? { ...row, id: 11, body: 'Answer' }
            : endpoint.includes('/pulls/1/comments')
              ? [row]
              : []
        ) as T;
      }
    }
    const github = new Stub();
    const rows = await github.discussion('org/repo', 1);
    expect(rows[0]).toMatchObject({
      reviewId: 42,
      location: { path: 'Service.java', side: 'head', line: 20, originalLine: 10 },
      diffHunk: '@@ -1,2 +1,2 @@\n-old()\n+run()',
    });
    expect(await github.reply('org/repo', 1, 10, 'Answer')).toMatchObject({
      id: 'inline:11',
      replyTo: 'inline:10',
      body: 'Answer',
    });
    expect(calls.at(-1)).toEqual({
      endpoint: 'repos/org/repo/pulls/1/comments/10/replies',
      options: { method: 'POST', body: { body: 'Answer' } },
    });
  });
  it('refreshes discussion without resetting analysis and publishes only explicit valid replies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-threads-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const github = new FakeGitHub(snap.pr!);
    let sent = 0;
    const gateway = Object.assign(github, {
      async discussion() {
        return [root, response].map(({ repoId: _repo, ...comment }) => comment);
      },
      async reply(_slug: string, _number: number, id: number, body: string) {
        sent++;
        expect(id).toBe(10);
        return { ...response, id: 'inline:13', body };
      },
    });
    const { app, store } = createApp({ dataDir: dir, github: gateway });
    cleanup.push(() => app.close());
    const session: ReviewSession = {
      id: 'session',
      title: 'Review',
      createdAt: '',
      snapshots: [snap],
      discussion: [root],
      run: {
        id: 'run',
        sessionId: 'session',
        state: 'partial',
        version: '1',
        fingerprint: 'saved',
        startedAt: '',
        events: [],
        result: {
          ...emptyModelResult(),
          summary: 'Keep original analysis',
          indexes: [],
          contracts: [],
        },
      },
    };
    store.saveSession(session);
    const request = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
        ...(payload ? { payload: JSON.stringify(payload) } : {}),
      });
    expect((await request('GET', '/api/sessions/session/discussion')).statusCode).toBe(200);
    expect(sent).toBe(0);
    expect(store.session('session')!.run).toEqual(session.run);
    expect(store.session('session')!.discussion).toEqual([root]); // analysis baseline is not consumed
    expect(store.session('session')!.threadDiscussion).toHaveLength(2);
    expect(
      (
        await request('POST', '/api/sessions/session/discussion/replies', {
          repoId: 'repo',
          rootId: 'inline:10',
          body: 'Continue',
        })
      ).statusCode,
    ).toBe(200);
    expect(store.session('session')!.threadDiscussion?.at(-1)?.body).toBe('Continue');
    for (const rootId of ['inline:11', 'inline:999', 'comment:10'])
      expect(
        (
          await request('POST', '/api/sessions/session/discussion/replies', {
            repoId: 'repo',
            rootId,
            body: 'No',
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await request('POST', '/api/sessions/session/discussion/replies', {
          repoId: 'other',
          rootId: 'inline:10',
          body: 'No',
        })
      ).statusCode,
    ).toBe(404);
    expect(sent).toBe(1);
    gateway.discussion = async () => {
      throw new Error('Unavailable');
    };
    const result = await new Discussions(store, gateway).refresh('session');
    expect(result.warnings).toHaveLength(1);
    expect(result.comments).toHaveLength(3);
  });
});
