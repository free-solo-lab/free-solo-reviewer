import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Snapshot, IndexedMethod, SourceIndex } from '../shared/model';
import { localAnalysisPrompt, prepareAnalysisWorkspace } from '../server/analysis-workspace';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('keeps source and index on disk, with bounded prompts and changing stage targets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-local-workspace-test-'));
  roots.push(home);
  const source = join(home, 'snapshot');
  await mkdir(source);
  await writeFile(join(source, 'Example.kt'), 'class Example { /* source stays on disk */ }');
  const snapshot = {
    repoId: 'r',
    repoName: 'example',
    headDir: source,
    baseDir: source,
    headFiles: ['Example.kt'],
    baseFiles: ['Example.kt'],
    files: [],
    local: {},
  } as unknown as Snapshot;
  const input = { snapshots: [snapshot], indexes: [] };
  const root = await prepareAnalysisWorkspace(home, input);
  expect(await readFile(join(root, 'repo-1/head/Example.kt'), 'utf8')).toContain(
    'source stays on disk',
  );
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  expect(manifest.repositories[0]).toEqual({ directory: 'repo-1', name: 'example', target: true });
  const prompt = localAnalysisPrompt(input);
  expect(prompt).not.toContain('source stays on disk');
  expect(prompt.length).toBeLessThan(8000);
  expect(prompt).toContain('Current stage: review');
  // Descriptions explain the essence; the diff shows how the code was before.
  expect(prompt).toContain('### Summary');
  expect(prompt).toContain('followUp.summary');
  expect(prompt).not.toContain('До и после');
  await prepareAnalysisWorkspace(home, { ...input, testsOnly: true });
  expect(localAnalysisPrompt({ ...input, testsOnly: true })).toContain('Current stage: tests');
});
it('lists only the current stage targets and no line arrays in the manifest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-local-manifest-test-'));
  roots.push(home);
  const source = join(home, 'snapshot');
  await mkdir(source);
  await writeFile(join(source, 'Example.kt'), 'class Example\n');
  const snapshot = {
    repoId: 'r',
    repoName: 'example',
    headDir: source,
    baseDir: source,
    headFiles: ['Example.kt'],
    baseFiles: ['Example.kt'],
    files: [{ path: 'Example.kt', status: 'M', patch: '@@', addedLines: [1], removedLines: [1] }],
    local: {},
  } as unknown as Snapshot;
  const input = { snapshots: [snapshot], indexes: [] };
  const manifestFor = async (stage: object) => {
    const root = await prepareAnalysisWorkspace(home, { ...input, ...stage });
    return JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  };
  const review = await manifestFor({});
  expect(Object.keys(review)).toContain('scenarioRoots');
  expect(Object.keys(review)).not.toContain('testTargets');
  expect(Object.keys(review)).not.toContain('sqlTargets');
  expect(review.changes).toEqual([
    { id: 'F1', repo: 'repo-1', path: 'Example.kt', status: 'M', lines: '+1 -1' },
  ]);
  expect(await readFile(join(home, 'workspace/diffs/F1.diff'), 'utf8')).toBe('@@');
  const tests = await manifestFor({ testsOnly: true, testTargets: [] });
  expect(Object.keys(tests)).toContain('testTargets');
  expect(Object.keys(tests)).not.toContain('scenarioRoots');
  const sql = await manifestFor({ sqlOnly: true, sqlTargets: [] });
  expect(Object.keys(sql)).toEqual(expect.arrayContaining(['sqlTargets']));
  expect(Object.keys(sql)).not.toContain('testTargets');
});
it('keeps files from a previous stage, restores missing ones and never copies links', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-local-workspace-test-'));
  roots.push(home);
  const source = join(home, 'snapshot');
  await mkdir(join(source, 'a'), { recursive: true });
  await writeFile(join(source, 'a/A.kt'), 'class A');
  await writeFile(join(source, 'B.kt'), 'class B');
  await symlink(join(source, 'B.kt'), join(source, 'Link.kt'));
  const snapshot = {
    repoId: 'r',
    repoName: 'example',
    headDir: source,
    baseDir: source,
    headFiles: ['B.kt', 'Link.kt', 'a/A.kt'],
    baseFiles: ['a/A.kt'],
    files: [],
    local: {},
  } as unknown as Snapshot;
  const input = { snapshots: [snapshot], indexes: [] };
  const root = await prepareAnalysisWorkspace(home, input);
  const head = join(root, 'repo-1/head');
  expect((await readdir(head, { recursive: true })).sort()).toEqual(['B.kt', 'a', 'a/A.kt']);
  await chmod(join(head, 'B.kt'), 0o600);
  await writeFile(join(head, 'B.kt'), 'kept');
  await rm(join(head, 'a/A.kt'));
  await prepareAnalysisWorkspace(home, { ...input, testsOnly: true });
  expect(await readFile(join(head, 'B.kt'), 'utf8')).toBe('kept');
  expect(await readFile(join(head, 'a/A.kt'), 'utf8')).toBe('class A');
});

it('never exposes unchanged test methods as targets or in the stage navigation index', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-local-target-test-'));
  roots.push(home);
  const source = join(home, 'snapshot');
  await mkdir(source);
  const path = 'ReaderTest.kt';
  await writeFile(join(source, path), 'class ReaderTest {}');
  const changed: IndexedMethod = {
    name: 'changed',
    signature: 'fun changed()',
    annotations: ['@Test'],
    calls: [],
    evidence: { repoId: 'r', side: 'head', path, startLine: 10, endLine: 20 },
  };
  const unchanged = {
    ...changed,
    name: 'unchanged',
    evidence: { ...changed.evidence, startLine: 30, endLine: 40 },
  };
  const snapshot = {
    repoId: 'r',
    headDir: source,
    baseDir: source,
    headFiles: [path],
    baseFiles: [],
    files: [{ path, status: 'M', patch: '', addedLines: [12], removedLines: [12] }],
  } as unknown as Snapshot;
  const root = await prepareAnalysisWorkspace(home, {
    snapshots: [snapshot],
    indexes: [{ repoId: 'r', side: 'head', methods: [changed, unchanged] } as SourceIndex],
    testsOnly: true,
    testTargets: [changed, unchanged],
  });
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  expect(manifest.testTargets.map((method: { name: string }) => method.name)).toEqual(['changed']);
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
  expect(index.flatMap((i: SourceIndex) => i.methods.map((m) => m.name))).toEqual(['changed']);
});

it('writes noisy patches as a note and gives targets and the index short refs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-local-refs-test-'));
  roots.push(home);
  const source = join(home, 'snapshot');
  await mkdir(join(source, 'dashboards'), { recursive: true });
  await writeFile(join(source, 'Reader.kt'), 'class Reader');
  await writeFile(join(source, 'dashboards/board.json'), '{}');
  const method: IndexedMethod = {
    name: 'read',
    signature: 'fun read()',
    annotations: [],
    calls: [],
    evidence: { repoId: 'r', side: 'head', path: 'Reader.kt', startLine: 3, endLine: 9 },
  };
  const snapshot = {
    repoId: 'r',
    repoName: 'example',
    headDir: source,
    baseDir: source,
    headFiles: ['Reader.kt', 'dashboards/board.json'],
    baseFiles: ['Reader.kt'],
    files: [
      { path: 'Reader.kt', status: 'M', patch: '@@ -4 +4 @@', addedLines: [4], removedLines: [4] },
      {
        path: 'dashboards/board.json',
        status: 'A',
        patch: `+${'x'.repeat(500)}`,
        addedLines: [1],
        removedLines: [],
      },
    ],
    local: {},
  } as unknown as Snapshot;
  const root = await prepareAnalysisWorkspace(home, {
    snapshots: [snapshot],
    indexes: [{ repoId: 'r', side: 'head', methods: [method] } as SourceIndex],
  });
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  expect(manifest.changes[1]).toMatchObject({ id: 'F2', omitted: true });
  expect(await readFile(join(root, 'diffs/F2.diff'), 'utf8')).toMatch(/^Patch omitted/);
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
  expect(index[0].methods[0].at).toBe('F1:3-9');
  expect(JSON.stringify(manifest)).not.toContain('"r"');
});
