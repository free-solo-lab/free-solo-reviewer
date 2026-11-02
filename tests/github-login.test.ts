import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { GitHubLogin, type GitHubLoginTools } from '../server/github-login';
import type { GitHubAccounts } from '../shared/model';

function fakeGh() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', null);
      return true;
    }),
  });
  return child;
}
function tools(accounts: GitHubAccounts[]) {
  const child = fakeGh();
  const value: GitHubLoginTools & { args?: string[]; env?: NodeJS.ProcessEnv } = {
    spawn: (args, env) => {
      value.args = args;
      value.env = env;
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    accounts: vi.fn(async () => accounts.shift()!),
    switchAccount: vi.fn(async () => undefined),
  };
  return { child, value };
}
const prompt =
  '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n';

describe('adding a GitHub account from the app', () => {
  it('shows the device code and keeps the previously active account active', async () => {
    const { child, value } = tools([
      { active: 'octo-work', accounts: ['octo-work'] },
      { active: 'octodev91', accounts: ['octo-work', 'octodev91'] },
    ]);
    const login = new GitHubLogin(value);
    const started = login.start();
    child.stderr.write(prompt);
    expect(await started).toEqual({
      state: 'waiting',
      code: 'AB12-CD34',
      url: 'https://github.com/login/device',
    });
    expect(value.args).toEqual(['auth', 'login', '--hostname', 'github.com', '--web']);
    expect(value.env?.GH_BROWSER).toBe('true');
    // A second request while waiting shows the same code instead of starting again.
    expect(await login.start()).toEqual(login.status());
    child.emit('close', 0);
    await vi.waitFor(() => expect(login.status()).toEqual({ state: 'done', login: 'octodev91' }));
    expect(value.switchAccount).toHaveBeenCalledWith('octo-work');
  });
  it('reports a login that gh did not complete and can be cancelled', async () => {
    const { child, value } = tools([{ active: null, accounts: [] }]);
    const login = new GitHubLogin(value);
    const started = login.start();
    child.stderr.write(prompt);
    await started;
    child.stderr.write('error: the device code expired\n');
    child.emit('close', 1);
    expect(login.status()).toEqual({ state: 'failed', error: 'error: the device code expired' });

    const next = tools([{ active: null, accounts: [] }]);
    const again = new GitHubLogin(next.value);
    const waiting = again.start();
    next.child.stderr.write(prompt);
    await waiting;
    again.cancel();
    expect(next.child.kill).toHaveBeenCalled();
    expect(again.status()).toEqual({ state: 'idle' });
  });
  it('explains when gh exits before giving a code', async () => {
    const { child, value } = tools([{ active: null, accounts: [] }]);
    const started = new GitHubLogin(value).start();
    await vi.waitFor(() => expect(value.args).toBeDefined());
    child.stderr.write('gh: not supported\n');
    child.emit('close', 1);
    await expect(started).rejects.toThrow('Не удалось начать вход в GitHub: gh: not supported');
  });
});
