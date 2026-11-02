import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../server/process';
import { shellIntegration } from '../server/shell-integration';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it('leaves shells other than zsh unchanged', () => {
  expect(shellIntegration('/bin/bash', '/nonexistent', { HOME: '/home/u' })).toEqual({});
});
it.skipIf(!existsSync('/bin/zsh'))(
  'starts zsh with the user setup and git completion, then hands ZDOTDIR back',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zsh-home-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    // A user setup without the completion system, like a fresh macOS account.
    await writeFile(join(home, '.zshrc'), 'USER_SETUP=loaded\n');
    const base = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const env = { ...base, ...shellIntegration('/bin/zsh', join(home, 'integration'), base) };
    const output = await command(
      '/bin/zsh',
      [
        '-l',
        '-i',
        '-c',
        'print -r -- "$USER_SETUP|$_comps[git]|$ZDOTDIR|${REVIEWER_ZDOTDIR-unset}"',
      ],
      { env, cwd: home },
    );
    expect(output.trim().split('\n').at(-1)).toBe(`loaded|_git|${home}|unset`);
  },
);
