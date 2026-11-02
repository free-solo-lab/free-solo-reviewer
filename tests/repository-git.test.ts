import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../server/process.js';
import { changedFiles, createSnapshot } from '../server/repository.js';
import type { GitHubGateway } from '../server/github.js';
import type { Repository } from '../shared/model.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'review-git-'));
  roots.push(root);
  const path = join(root, 'repo');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.email', 'test@example.com']);
  await git(path, ['config', 'user.name', 'Review test']);
  // Non-ASCII paths are then quoted in diff headers, which exercises the per-file fallback.
  await git(path, ['config', 'core.quotePath', 'true']);
  const put = async (name: string, text: string) => {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), text);
  };
  const commit = async () => {
    await git(path, ['add', '-A']);
    await git(path, ['commit', '-m', 'change']);
    return (await git(path, ['rev-parse', 'HEAD'])).trim();
  };
  const repo: Repository = { id: 'repo', path, name: 'repo', slug: 'local/repo' };
  return { root, repo, put, commit };
}
const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

describe('git snapshots', () => {
  it('materializes text files byte for byte and skips binary content', async () => {
    const { root, repo, put, commit } = await repository();
    await put('src/Main.java', '// заказ\nclass Main {}\n');
    await put('Пример.md', '# Пример\n');
    await put('docs/blob.txt', 'a\0b');
    await commit();
    const snapshot = await createSnapshot(repo, null, join(root, 'snapshots'), {} as GitHubGateway);
    expect(snapshot.headFiles).toEqual(['src/Main.java', 'Пример.md']);
    expect(await readFile(join(snapshot.headDir, 'src/Main.java'), 'utf8')).toBe(
      '// заказ\nclass Main {}\n',
    );
    expect(await readFile(join(snapshot.baseDir, 'Пример.md'), 'utf8')).toBe('# Пример\n');
  });

  it.each([
    ['plain paths', 'docs/notes.md'],
    ['paths git quotes', 'docs/заметки.md'],
  ])('splits one diff into the same patches as per-file diffs (%s)', async (_, notes) => {
    const { repo, put, commit } = await repository();
    await put('src/Old.java', body(30));
    await put(notes, body(5));
    const base = await commit();
    await git(repo.path, ['mv', 'src/Old.java', 'src/New.java']);
    await put('src/New.java', body(30).replace('line 12', 'line twelve'));
    await put(notes, body(6));
    await put('src/Added.java', 'class Added {}\n');
    const head = await commit();
    const files = await changedFiles(repo, base, head);
    expect(files.map((file) => [file.status[0], file.path, file.oldPath])).toEqual([
      ['M', notes, undefined],
      ['A', 'src/Added.java', undefined],
      ['R', 'src/New.java', 'src/Old.java'],
    ]);
    for (const file of files)
      expect(file.patch).toBe(
        await git(repo.path, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--find-renames',
          '-U4',
          base,
          head,
          '--',
          ...(file.oldPath ? [file.oldPath] : []),
          file.path,
        ]),
      );
    expect(files.find((file) => file.path === 'src/New.java')?.addedLines).toEqual([13]);
  });
});
