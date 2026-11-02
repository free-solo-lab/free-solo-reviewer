import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../server/process.js';
import { checkoutPullRequest } from '../server/working-files.js';
import { isWrongBranch, wrongBranchMessage } from '../shared/code-edits.js';
import type { Repository, Snapshot } from '../shared/model.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repository() {
  const path = await mkdtemp(join(tmpdir(), 'review-checkout-'));
  roots.push(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.email', 'test@example.com']);
  await git(path, ['config', 'user.name', 'Review test']);
  const commit = async (name: string, text: string) => {
    await writeFile(join(path, name), text);
    await git(path, ['add', '-A']);
    await git(path, ['commit', '-m', name]);
    return (await git(path, ['rev-parse', 'HEAD'])).trim();
  };
  await commit('a.txt', 'main\n');
  const repo: Repository = { id: 'repo', path, name: 'repo', slug: 'local/repo' };
  const head = async () => (await git(path, ['rev-parse', 'HEAD'])).trim();
  const branch = async () => (await git(path, ['branch', '--show-current'])).trim();
  return { path, repo, commit, head, branch };
}
const snapshot = (headSha: string) =>
  ({ headSha, pr: { number: 7, headRefName: 'feature' } }) as unknown as Snapshot;

describe('switching the working folder to the PR branch', () => {
  it('creates the PR branch at the reviewed commit', async () => {
    const { path, repo, commit, head, branch } = await repository();
    await git(path, ['switch', '-c', 'tmp']);
    const sha = await commit('b.txt', 'pr\n');
    await git(path, ['switch', 'main']);
    await git(path, ['branch', '-D', 'tmp']);
    await expect(checkoutPullRequest(repo, snapshot(sha))).resolves.toEqual({ branch: 'feature' });
    expect(await branch()).toBe('feature');
    expect(await head()).toBe(sha);
  });

  it('moves a local branch that is behind forward to the PR commit', async () => {
    const { path, repo, commit, head, branch } = await repository();
    await git(path, ['switch', '-c', 'feature']);
    await commit('b.txt', 'one\n');
    await git(path, ['branch', 'old']);
    const sha = await commit('b.txt', 'two\n');
    await git(path, ['switch', 'main']);
    await git(path, ['branch', '-f', 'feature', 'old']);
    await checkoutPullRequest(repo, snapshot(sha));
    expect(await branch()).toBe('feature');
    expect(await head()).toBe(sha);
  });

  it('keeps uncommitted work and a diverged local branch untouched', async () => {
    const { path, repo, commit, head, branch } = await repository();
    await git(path, ['switch', '-c', 'tmp']);
    const sha = await commit('b.txt', 'pr\n');
    await git(path, ['switch', 'main']);
    await writeFile(join(path, 'a.txt'), 'unsaved\n');
    await expect(checkoutPullRequest(repo, snapshot(sha))).rejects.toThrow(
      'незакоммиченные изменения',
    );
    await git(path, ['checkout', '--', 'a.txt']);
    await git(path, ['switch', '-c', 'feature']);
    await commit('c.txt', 'local only\n');
    await git(path, ['switch', 'main']);
    const before = await head();
    await expect(checkoutPullRequest(repo, snapshot(sha))).rejects.toThrow('расходится с PR');
    expect(await branch()).toBe('main');
    expect(await head()).toBe(before);
  });

  it('recognizes its own wrong-branch message', () => {
    expect(isWrongBranch(wrongBranchMessage('ft/error-log-policy'))).toBe(true);
    expect(isWrongBranch('Файл не найден в рабочей папке или исключён Git.')).toBe(false);
  });
});
