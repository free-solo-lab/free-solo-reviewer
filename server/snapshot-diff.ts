import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangedFile, Snapshot, Side } from '../shared/model.js';
import { patchLines } from '../shared/patch.js';
import { readSource } from './repository.js';
import { command, CommandError } from './process.js';

/** Works across local/private Git stores and GitHub commits, and after a restart. */
export async function snapshotDiff(
  before: Snapshot,
  after: Snapshot,
  side: Side = 'head',
): Promise<ChangedFile[]> {
  const oldFiles = side === 'base' ? before.baseFiles : before.headFiles;
  const paths = [...new Set([...oldFiles, ...after.headFiles])].sort();
  const temp = await mkdtemp(join(tmpdir(), 'reviewer-diff-'));
  try {
    const changes: ChangedFile[] = [];
    for (const path of paths) {
      const a = oldFiles.includes(path) ? await readSource(before, { side, path }) : null;
      const b = after.headFiles.includes(path)
        ? await readSource(after, { side: 'head', path })
        : null;
      if (a === b) continue;
      await Promise.all([
        writeFile(join(temp, 'before'), a ?? ''),
        writeFile(join(temp, 'after'), b ?? ''),
      ]);
      let patch: string;
      try {
        patch = await command(
          'git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            '-U4',
            '--',
            'before',
            'after',
          ],
          { cwd: temp },
        );
      } catch (e) {
        if (!(e instanceof CommandError) || !e.stdout.startsWith('diff --git ')) throw e;
        patch = e.stdout;
      }
      patch = patch
        .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
        .replace(/^--- .*$/m, a === null ? '--- /dev/null' : `--- a/${path}`)
        .replace(/^\+\+\+ .*$/m, b === null ? '+++ /dev/null' : `+++ b/${path}`);
      const lines = [...patchLines(patch)];
      changes.push({
        path,
        status: a === null ? 'A' : b === null ? 'D' : 'M',
        patch,
        addedLines: lines.flatMap((l) => (l.kind === 'addition' ? [l.newLine] : [])),
        removedLines: lines.flatMap((l) => (l.kind === 'deletion' ? [l.oldLine] : [])),
      });
    }
    return changes;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
