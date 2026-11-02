import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import type { FeedbackGateway } from '../server/feedback';
import type { FeedbackList, FeedbackThread } from '../shared/feedback';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** Issues and comments of the project's repository, as GitHub's REST API returns them. */
function fakeGitHub() {
  const issues: Record<string, unknown>[] = [];
  const comments: Record<number, Record<string, unknown>[]> = {};
  const calls: { endpoint: string; body?: unknown; slug?: string }[] = [];
  let clock = Date.parse('2026-11-01T10:00:00Z');
  const now = () => new Date((clock += 60_000)).toISOString();
  const gateway: FeedbackGateway = {
    user: async () => ({ login: 'me' }),
    api: async <T>(
      endpoint: string,
      options?: { method: string; body: unknown },
      slug?: string,
    ) => {
      calls.push({ endpoint, body: options?.body, slug });
      const path = endpoint.replace('repos/free-solo-lab/free-solo-reviewer/', '').split('?')[0];
      const body = options?.body as { title?: string; body: string } | undefined;
      let match: RegExpExecArray | null;
      if (path === 'issues' && options?.method === 'POST') {
        const at = now();
        const row = {
          number: issues.length + 1,
          title: body!.title,
          body: body!.body,
          state: 'open',
          html_url: `https://github.com/free-solo-lab/free-solo-reviewer/issues/${issues.length + 1}`,
          created_at: at,
          updated_at: at,
          comments: 0,
          user: { login: 'me' },
        };
        issues.push(row);
        return row as T;
      }
      if (path === 'issues') return [...issues].reverse() as T;
      if ((match = /^issues\/(\d+)\/comments$/.exec(path))) {
        const number = Number(match[1]);
        const list = (comments[number] ??= []);
        if (options?.method === 'POST') {
          const at = now();
          list.push({
            id: list.length + 1,
            body: body!.body,
            html_url: 'c',
            created_at: at,
            user: { login: 'me' },
          });
          Object.assign(issues[number - 1], { comments: list.length, updated_at: at });
        }
        return list as T;
      }
      if ((match = /^issues\/(\d+)$/.exec(path))) return issues[Number(match[1]) - 1] as T;
      throw new Error(`Unexpected call ${endpoint}`);
    },
  };
  const answer = (number: number, author: string) => {
    const at = now();
    const list = (comments[number] ??= []);
    list.push({
      id: list.length + 1,
      body: 'Thanks, fixed',
      html_url: 'c',
      created_at: at,
      user: { login: author },
    });
    Object.assign(issues[number - 1], { comments: list.length, updated_at: at });
  };
  return { gateway, calls, answer };
}

it('files feedback as an issue of the project and shows replies that arrive later', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const github = fakeGitHub();
  const { app } = createApp({ dataDir: dir, feedback: github.gateway });
  cleanup.push(() => app.close());
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, payload: payload as object });

  const created = await call('POST', '/feedback', {
    kind: 'bug',
    title: 'Settings do not scroll',
    body: 'The analysis scheme is cut off.',
    diagnostics: true,
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json()).toMatchObject({ number: 1, kind: 'bug', title: 'Settings do not scroll' });
  const sent = github.calls.find((c) => c.endpoint.endsWith('/issues'))!;
  expect(sent.slug).toBe('free-solo-lab/free-solo-reviewer');
  expect(sent.body).toMatchObject({ title: '[Bug] Settings do not scroll', labels: ['bug'] });
  expect((sent.body as { body: string }).body).toContain('Node.js');

  // A maintainer answers on GitHub; the user's own replies are never "new".
  github.answer(1, 'maintainer');
  github.answer(1, 'me');
  const list = (await call('GET', '/feedback')).json<FeedbackList>();
  expect(list).toMatchObject({ login: 'me', repository: 'free-solo-lab/free-solo-reviewer' });
  expect(list.issues[0]).toMatchObject({ number: 1, comments: 2, unread: 1, state: 'open' });

  const thread = (await call('GET', '/feedback/1')).json<FeedbackThread>();
  expect(thread.issue.body).toMatch(/^The analysis scheme is cut off\.\n\n---\n<sub>Reviewer · /);
  expect(thread.issue.body).not.toContain('reviewer-feedback');
  expect(thread.comments.map((c) => [c.author, c.own])).toEqual([
    ['maintainer', false],
    ['me', true],
  ]);
  expect((await call('GET', '/feedback')).json<FeedbackList>().issues[0].unread).toBe(0);

  const replied = await call('POST', '/feedback/1/comments', { body: 'Works now' });
  expect(replied.json<FeedbackThread>().comments.at(-1)).toMatchObject({
    own: true,
    body: 'Works now',
  });
  expect(
    (await call('POST', '/feedback', { kind: 'nope', title: 'abc', body: 'x', diagnostics: false }))
      .statusCode,
  ).toBe(400);
});

it('has no feedback in the demo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-demo-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { app } = createApp({ dataDir: dir, demo: true });
  cleanup.push(() => app.close());
  expect((await app.inject({ method: 'GET', url: '/api/feedback' })).statusCode).toBe(503);
});
