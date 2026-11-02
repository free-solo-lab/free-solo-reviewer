import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { fixture, FixtureProvider } from './fixtures';
import { createApp } from '../server/app';
import type { ReviewDiscussion, ReviewSession } from '../shared/model';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition not reached');
}

it('keeps replies saved while an analysis is running', async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const root: Omit<ReviewDiscussion, 'repoId'> = {
    id: 'inline:10',
    author: 'reviewer',
    body: 'Why?',
    at: '2026-10-19T10:00:00Z',
    updatedAt: '2026-10-19T10:00:00Z',
    url: `${f.pr.url}#discussion_r10`,
  };
  const github = Object.assign(f.github, {
    async discussion() {
      return [root];
    },
    async reply(_slug: string, _number: number, _id: number, body: string) {
      return { ...root, id: 'inline:11', replyTo: 'inline:10', body };
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  const delegate = new FixtureProvider();
  const { app, store } = createApp({
    dataDir: join(f.root, 'app'),
    github,
    provider: {
      id: 'blocking-fixture',
      async analyze(input, signal, progress) {
        started = true;
        await gate;
        return delegate.analyze(input, signal, progress);
      },
    },
  });
  cleanup.push(() => app.close());
  store.saveRepository(f.repo);
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const session = (
    await request('POST', '/api/sessions', {
      title: 'Race',
      repositories: [{ repoId: f.repo.id, prNumber: 12 }],
    })
  ).json<ReviewSession>();
  await request('POST', `/api/sessions/${session.id}/analyze`, {});
  await waitFor(() => started);
  expect((await request('GET', `/api/sessions/${session.id}/discussion`)).statusCode).toBe(200);
  const reply = await request('POST', `/api/sessions/${session.id}/discussion/replies`, {
    repoId: f.repo.id,
    rootId: 'inline:10',
    body: 'Because',
  });
  expect(reply.statusCode).toBe(200);
  release();
  await waitFor(() => store.session(session.id)?.run?.state !== 'running');
  expect(store.session(session.id)?.threadDiscussion?.map((comment) => comment.body)).toEqual([
    'Why?',
    'Because',
  ]);
});
