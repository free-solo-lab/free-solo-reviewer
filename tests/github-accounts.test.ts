import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHub, githubAccounts } from '../server/github';
import * as processTools from '../server/process';
import { createApp } from '../server/app';
import { ownReviewDiscussion } from '../server/discussion';
import { FakeGitHub } from './fixtures';
import type { GitHubAccounts, PullRequest, Repository, ReviewRequest } from '../shared/model';

const ok = (body: unknown) => `HTTP/2.0 200 OK\r\nDate: now\r\n\r\n${JSON.stringify(body)}`;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('GitHub account per repository', () => {
  it('runs gh with the chosen account token and the active account otherwise', async () => {
    const command = vi.spyOn(processTools, 'command').mockImplementation(async (_bin, args) => {
      if (args[0] === 'auth') return 'company-token\n';
      return ok({ login: 'octodev91' });
    });
    const github = new GitHub((slug) => (slug === 'vandelay/order_java' ? 'octodev91' : undefined));
    await github.api('repos/vandelay/order_java/pulls/87');
    await github.user('vandelay/order_java');
    await github.api('repos/initech/backoffice/pulls/1');
    await github.user();
    const calls = command.mock.calls.map(([, args, options]) => ({
      args,
      token: options?.env?.GH_TOKEN,
    }));
    // The token is read once and reused while it is fresh.
    expect(calls.filter((call) => call.args[0] === 'auth')).toEqual([
      {
        args: ['auth', 'token', '--hostname', 'github.com', '--user', 'octodev91'],
        token: undefined,
      },
    ]);
    const api = calls.filter((call) => call.args[0] === 'api');
    expect(api.map((call) => [call.args[4], call.token])).toEqual([
      ['repos/vandelay/order_java/pulls/87', 'company-token'],
      ['user', 'company-token'],
      ['repos/initech/backoffice/pulls/1', undefined],
      ['user', undefined],
    ]);
  });
  it('explains a chosen account that gh is not logged in to', async () => {
    vi.spyOn(processTools, 'command').mockRejectedValue(new Error('no account'));
    await expect(new GitHub(() => 'octodev91').listPRs('vandelay/order_java')).rejects.toThrow(
      'Аккаунт GitHub octodev91 не найден в gh',
    );
  });
  it('lists logged-in gh accounts and the active one', async () => {
    vi.spyOn(processTools, 'command').mockResolvedValue(
      JSON.stringify({
        hosts: {
          'github.com': [
            { login: 'octo-work', active: true, state: 'success' },
            { login: 'octodev91', active: false, state: 'success' },
            { login: 'expired', active: false, state: 'error' },
          ],
        },
      }),
    );
    expect(await githubAccounts()).toEqual({
      active: 'octo-work',
      accounts: ['octo-work', 'octodev91'],
    });
  });
  it('saves and clears the account of a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-accounts-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const github = Object.assign(new FakeGitHub({} as PullRequest), {
      accounts: async (): Promise<GitHubAccounts> => ({
        active: 'octo-work',
        accounts: ['octo-work', 'octodev91'],
      }),
    });
    const { app, store } = createApp({ dataDir: join(root, 'data'), github });
    cleanup.push(() => app.close());
    const repo: Repository = {
      id: 'r1',
      path: root,
      name: 'order_java',
      slug: 'vandelay/order_java',
    };
    store.saveRepository(repo);
    const choose = (githubUser: string | null) =>
      app.inject({
        method: 'PUT',
        url: '/api/repositories/r1/github-user',
        payload: { githubUser },
      });
    expect((await app.inject({ method: 'GET', url: '/api/github/accounts' })).json()).toEqual({
      active: 'octo-work',
      accounts: ['octo-work', 'octodev91'],
      current: 'octo-work',
    });
    expect((await choose('octodev91')).json<Repository>().githubUser).toBe('octodev91');
    expect(store.repository('r1')?.githubUser).toBe('octodev91');
    expect((await choose('someone-else')).statusCode).toBe(400);
    expect((await choose('--user')).statusCode).toBe(400);
    expect(store.repository('r1')?.githubUser).toBe('octodev91');
    expect((await choose(null)).json<Repository>().githubUser).toBeUndefined();
    expect(store.repository('r1')).toEqual(repo);
  });
  it('switches the current user and links review requests to connected repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-requests-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const github = Object.assign(new FakeGitHub({} as PullRequest), {
      accounts: async (): Promise<GitHubAccounts> => ({
        active: 'octo-work',
        accounts: ['octo-work', 'octodev91'],
      }),
      reviewRequests: async (login?: string) => [
        {
          slug: 'Vandelay/Order_Java',
          number: login === 'octodev91' ? 88 : 87,
          title: 'Error log policy',
          url: 'https://github.com/vandelay/order_java/pull/87',
          author: 'jvmdev4',
          updatedAt: '2026-10-27T10:00:00Z',
          draft: false,
          direct: true,
        },
        {
          slug: 'initech/cloud-infra',
          number: 2125,
          title: 'fix requestId',
          url: 'https://github.com/initech/cloud-infra/pull/2125',
          author: 'dev',
          updatedAt: '2026-10-27T10:00:00Z',
          draft: false,
          direct: false,
        },
      ],
    });
    const { app, store } = createApp({ dataDir: join(root, 'data'), github });
    cleanup.push(() => app.close());
    store.saveRepository({
      id: 'r1',
      path: root,
      name: 'order_java',
      slug: 'vandelay/order_java',
    });
    const switchTo = (githubUser: string | null) =>
      app.inject({ method: 'PUT', url: '/api/github/current', payload: { githubUser } });
    expect((await switchTo('octodev91')).json<GitHubAccounts>().current).toBe('octodev91');
    expect(store.githubUser()).toBe('octodev91');
    expect((await switchTo('unknown')).statusCode).toBe(400);
    expect(store.githubUser()).toBe('octodev91');
    expect((await switchTo(null)).json<GitHubAccounts>().current).toBe('octo-work');
    expect(store.githubUser()).toBeUndefined();
    const requests = (await app.inject({ method: 'GET', url: '/api/github/review-requests' })).json<
      ReviewRequest[]
    >();
    expect(requests.map((request) => request.repoId)).toEqual(['r1', undefined]);
    const forUser = (login: string) =>
      app.inject({ method: 'GET', url: `/api/github/review-requests?login=${login}` });
    // A specific user's list does not depend on who is current in the app.
    expect((await forUser('octodev91')).json<ReviewRequest[]>()[0].number).toBe(88);
    expect((await forUser('unknown')).statusCode).toBe(400);
    expect((await forUser('--user')).statusCode).toBe(400);
  });
  it('finds PRs requesting review from the current user and marks personal requests', async () => {
    const item = (number: number) => ({
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/org/repo/pull/${number}`,
      repository_url: 'https://api.github.com/repos/org/repo',
      user: { login: 'author' },
      updated_at: '2026-10-27T10:00:00Z',
      draft: number === 2,
    });
    const command = vi.spyOn(processTools, 'command').mockImplementation(async (_bin, args) => {
      if (args[0] === 'auth') return 'current-token\n';
      const query = new URLSearchParams(String(args[4]).split('?')[1]).get('q') ?? '';
      return ok({
        items: query.includes('user-review-requested') ? [item(1)] : [item(1), item(2)],
      });
    });
    const requests = await new GitHub((slug) => (slug ? undefined : 'octodev91')).reviewRequests();
    expect(requests).toEqual([
      expect.objectContaining({ slug: 'org/repo', number: 1, direct: true, draft: false }),
      expect.objectContaining({ slug: 'org/repo', number: 2, direct: false, draft: true }),
    ]);
    const searches = command.mock.calls.filter(([, args]) => args[0] === 'api');
    expect(searches.map(([, , options]) => options?.env?.GH_TOKEN)).toEqual([
      'current-token',
      'current-token',
    ]);
    expect(String(searches[0][1][4])).toContain('archived%3Afalse');
  });
  it('treats comments of every account used in the review as own', () => {
    const own = ownReviewDiscussion([], [], ['octo-work', 'OctoDev91']);
    const comment = (author: string) => ({
      id: 'inline:1',
      repoId: 'r1',
      body: 'Ответ',
      author,
      url: '',
      at: '',
      updatedAt: '',
    });
    expect(own(comment('octodev91'))).toBe(true);
    expect(own(comment('octo-work'))).toBe(true);
    expect(own(comment('jvmdev4'))).toBe(false);
  });
});
