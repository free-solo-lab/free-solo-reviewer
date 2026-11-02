import { describe, expect, it } from 'vitest';
import {
  changedFileTree,
  snapshotTreeFiles,
  snapshotRole,
  type FileTreeNode,
} from '../shared/file-tree';
import type { ChangedFile, Snapshot } from '../shared/model';

const file = (path: string, oldPath?: string): ChangedFile => ({
  path,
  oldPath,
  status: oldPath ? 'R' : 'M',
  patch: '',
  addedLines: [1],
  removedLines: [2],
});
const leaves = (nodes: FileTreeNode[]): ChangedFile[] =>
  nodes.flatMap((node) => (node.file ? [node.file] : leaves(node.children)));

describe('changed file navigation tree', () => {
  it('compacts directory chains while retaining branches, counts and full selection paths', () => {
    const files = [
      file('src/main/kotlin/com/bg/service/Service.kt'),
      file('src/main/kotlin/com/bg/model/Model.kt'),
      file('README.md'),
    ];
    const tree = changedFileTree(files);
    expect(tree[0]).toMatchObject({
      name: 'src/main/kotlin/com/bg',
      path: 'src/main/kotlin/com/bg',
      count: 2,
    });
    expect(tree[0].children.map((node) => node.name)).toEqual(['model', 'service']);
    expect(tree[1]).toMatchObject({ name: 'README.md', count: 1 });
    expect(
      leaves(tree)
        .map((item) => item.path)
        .sort(),
    ).toEqual(files.map((item) => item.path).sort());
  });
  it('keeps identical basenames separate and retains rename/diff metadata', () => {
    const renamed = file('src/new/Service.kt', 'src/old/Service.kt');
    const test = file('src/test/Service.kt');
    const result = leaves(changedFileTree([renamed, test]));
    expect(result).toContain(renamed);
    expect(result).toContain(test);
    expect(result).toHaveLength(2);
    expect(changedFileTree([])).toEqual([]);
  });

  const snapshot = (headFiles: string[], files: ChangedFile[] = []): Snapshot => ({
    id: 'snapshot',
    repoId: 'repo',
    repoName: 'service',
    slug: 'org/service',
    pr: null,
    baseSha: 'base',
    headSha: 'head',
    mergeBase: 'base',
    baseDir: '/base',
    headDir: '/head',
    baseFiles: [],
    headFiles,
    files,
  });

  it('shows the whole snapshot while retaining removed files and change metadata', () => {
    const modified = file('src/Changed.kt');
    const removed = { ...file('src/Removed.kt'), status: 'D' };
    const all = snapshotTreeFiles(
      snapshot(['src/Changed.kt', 'src/Untouched.kt'], [modified, removed]),
    );
    expect(all).toHaveLength(3);
    expect(all.find((item) => item.path === modified.path)).toBe(modified);
    expect(all.find((item) => item.path === 'src/Untouched.kt')?.status).toBe('unchanged');
    expect(all).toContain(removed);
  });

  it('recognizes standalone protocol repositories and protocols inside a service', () => {
    expect(snapshotRole(snapshot(['api/documents.proto']))).toBe('Протоколы');
    expect(snapshotRole(snapshot(['src/main/kotlin/Service.kt']))).toBe('Сервис');
    expect(snapshotRole(snapshot(['src/main/kotlin/Service.kt', 'proto/docs.proto']))).toBe(
      'Сервис · протоколы',
    );
    expect(snapshotRole(snapshot(['README.md']))).toBe('Репозиторий');
  });
});
