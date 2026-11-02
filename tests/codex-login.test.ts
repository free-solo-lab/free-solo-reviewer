import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexLogin, type CodexLoginTools } from '../server/codex-login';

function fakeCodex() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', null);
      return true;
    }),
  });
  return child;
}
function tools() {
  const child = fakeCodex();
  const value: CodexLoginTools & { args?: string[] } = {
    spawn: (args) => {
      value.args = args;
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  };
  return { child, value };
}
// What `codex login --device-auth` prints, colors included.
const prompt =
  'Follow these steps to sign in with ChatGPT using device code authorization:\n\n' +
  '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mV0AK-X4YE9\x1b[0m\n';

describe('connecting Codex from the app', () => {
  it('shows the device code and keeps the login in a file', async () => {
    const { child, value } = tools();
    const login = new CodexLogin(value);
    const started = login.start();
    child.stdout.write(prompt);
    expect(await started).toEqual({
      state: 'waiting',
      code: 'V0AK-X4YE9',
      url: 'https://auth.openai.com/codex/device',
    });
    expect(value.args).toEqual([
      'login',
      '--device-auth',
      '-c',
      'cli_auth_credentials_store="file"',
    ]);
    expect(await login.start()).toEqual(login.status());
    child.emit('close', 0);
    expect(login.status()).toEqual({ state: 'done' });
  });
  it('reports an unfinished sign-in and can be cancelled', async () => {
    const { child, value } = tools();
    const login = new CodexLogin(value);
    const started = login.start();
    child.stdout.write(prompt);
    await started;
    child.stderr.write('Error: device code expired\n');
    child.emit('close', 1);
    expect(login.status()).toEqual({ state: 'failed', error: 'Error: device code expired' });

    const next = tools();
    const again = new CodexLogin(next.value);
    const waiting = again.start();
    next.child.stdout.write(prompt);
    await waiting;
    again.cancel();
    expect(next.child.kill).toHaveBeenCalled();
    expect(again.status()).toEqual({ state: 'idle' });
  });
  it('passes an API key through stdin, not through arguments', async () => {
    const { child, value } = tools();
    let input = '';
    child.stdin.on('data', (chunk: Buffer) => (input += chunk.toString()));
    const saved = new CodexLogin(value).apiKey('test-key-not-a-real-secret');
    await vi.waitFor(() => expect(input).toBe('test-key-not-a-real-secret\n'));
    expect(value.args?.join(' ')).not.toContain('test-key');
    child.emit('close', 0);
    expect(await saved).toEqual({ state: 'done' });
  });
  it('explains a rejected API key', async () => {
    const { child, value } = tools();
    const saved = new CodexLogin(value).apiKey('not-a-real-key-0123456789');
    await vi.waitFor(() => expect(value.args).toBeDefined());
    child.stderr.write('Error: invalid API key\n');
    child.emit('close', 1);
    await expect(saved).rejects.toThrow('Не удалось сохранить API-ключ: Error: invalid API key');
  });
});
