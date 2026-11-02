import type { SourceDiffRow } from './source-diff';

export interface SourceChangeBlock {
  start: number;
  end: number;
}

/** Adjacent removals and additions form one change, including deletion-only blocks. */
export function sourceChangeBlocks(
  rows: SourceDiffRow[],
  editedLines = new Set<number>(),
): SourceChangeBlock[] {
  const blocks: SourceChangeBlock[] = [];
  let current: SourceChangeBlock | undefined;
  rows.forEach((row, index) => {
    const changed =
      row.kind !== 'context' || (row.native && editedLines.has(row.evidence.startLine));
    if (!changed) {
      current = undefined;
      return;
    }
    if (current) current.end = index;
    else {
      current = { start: index, end: index };
      blocks.push(current);
    }
  });
  return blocks;
}

export function nextSourceChange(current: number, direction: -1 | 1, count: number) {
  if (!count) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
