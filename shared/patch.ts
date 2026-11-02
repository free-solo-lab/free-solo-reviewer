/** Unified diff parsing shared by the server, the analysis scope and the diff viewer. */
export interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}
export function parseHunkHeader(line: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return match
    ? {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
      }
    : null;
}

export type PatchLine =
  | { kind: 'hunk'; raw: string }
  | { kind: 'meta'; raw: string }
  | {
      kind: 'addition' | 'deletion' | 'context';
      raw: string;
      /** Line in the old file; for an addition, the old line it is inserted before. */
      oldLine: number;
      /** Line in the new file; for a deletion, the new line it was removed before. */
      newLine: number;
    };

/** Every patch line with its position: hunk headers, changed and context lines, and the rest. */
export function* patchLines(patch: string): Generator<PatchLine> {
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const raw of patch.split('\n')) {
    const header = parseHunkHeader(raw);
    if (header) {
      oldLine = header.oldStart;
      newLine = header.newStart;
      inHunk = true;
      yield { kind: 'hunk', raw };
      continue;
    }
    const kind =
      raw[0] === '+' ? 'addition' : raw[0] === '-' ? 'deletion' : raw[0] === ' ' ? 'context' : null;
    if (!inHunk || !kind) {
      yield { kind: 'meta', raw };
      continue;
    }
    yield { kind, raw, oldLine, newLine };
    if (kind !== 'addition') oldLine++;
    if (kind !== 'deletion') newLine++;
  }
}

/**
 * The last lines of a one-hunk diff with a header that numbers them right: GitHub's hunk of a
 * comment runs from the top of the change down to the commented line, which is the part that
 * matters.
 */
export function tailHunk(hunk: string, keep: number): string {
  const lines = [...patchLines(hunk)].filter(
    (line) => line.kind !== 'hunk' && line.kind !== 'meta',
  );
  if (lines.length <= keep) return hunk;
  const tail = lines.slice(-keep) as Extract<PatchLine, { oldLine: number }>[];
  const count = (kind: 'addition' | 'deletion') => tail.filter((line) => line.kind !== kind).length;
  return [
    `@@ -${tail[0].oldLine},${count('addition')} +${tail[0].newLine},${count('deletion')} @@`,
    ...tail.map((line) => line.raw),
  ].join('\n');
}
