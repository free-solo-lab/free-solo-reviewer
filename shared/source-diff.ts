import type { ChangedFile, Evidence } from './model.js';
import { parseHunkHeader } from './patch.js';
export interface SourceDiffRow {
  text: string;
  kind: 'addition' | 'deletion' | 'context';
  left: number | null;
  right: number | null;
  evidence: Evidence;
  native: boolean;
  historical?: boolean;
}
/** Full source with the opposite side's changed lines inserted at their diff anchors. */
export function sourceDiffRows(
  text: string,
  origin: Evidence,
  file?: ChangedFile,
): SourceDiffRow[] {
  const native = new Map<number, SourceDiffRow>();
  const inserted = new Map<number, SourceDiffRow[]>();
  const shifts = [{ line: 1, delta: 0 }];
  let left = 0,
    right = 0,
    inHunk = false;
  const finish = () => {
    if (inHunk)
      shifts.push({
        line: origin.side === 'head' ? right : left,
        delta: origin.side === 'head' ? left - right : right - left,
      });
  };
  for (const raw of (file?.patch ?? '').split('\n')) {
    const hunk = parseHunkHeader(raw);
    if (hunk) {
      finish();
      // An empty side names the line before the change; anchor rows after it.
      left = Math.max(1, hunk.oldStart + (hunk.oldCount === 0 ? 1 : 0));
      right = Math.max(1, hunk.newStart + (hunk.newCount === 0 ? 1 : 0));
      inHunk = true;
      continue;
    }
    if (!inHunk || !['+', '-', ' '].includes(raw[0] ?? '')) continue;
    const kind = raw[0] === '+' ? 'addition' : raw[0] === '-' ? 'deletion' : 'context';
    const side = kind === 'deletion' ? 'base' : kind === 'addition' ? 'head' : origin.side;
    const row: SourceDiffRow = {
      text: raw.slice(1),
      kind,
      left: kind === 'addition' ? null : left,
      right: kind === 'deletion' ? null : right,
      native: side === origin.side,
      evidence: {
        ...origin,
        side,
        path:
          side === 'base'
            ? (file?.oldPath ?? file?.path ?? origin.path)
            : (file?.path ?? origin.path),
        startLine: side === 'base' ? left : right,
        endLine: side === 'base' ? left : right,
      },
    };
    if (row.native) native.set(origin.side === 'head' ? right : left, row);
    else {
      const anchor = origin.side === 'head' ? right : left;
      inserted.set(anchor, [...(inserted.get(anchor) ?? []), row]);
    }
    if (kind !== 'addition') left++;
    if (kind !== 'deletion') right++;
  }
  finish();
  const added = new Set(file?.addedLines),
    removed = new Set(file?.removedLines);
  const rows: SourceDiffRow[] = [];
  // Git does not treat the trailing newline as an additional empty line.
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  lines.forEach((value, index) => {
    const number = index + 1;
    rows.push(...(inserted.get(number) ?? []));
    const known = native.get(number);
    const shift = shifts.filter((s) => s.line <= number).at(-1)!.delta;
    const kind =
      known?.kind ??
      (origin.side === 'head' && (added.has(number) || ['A', 'added'].includes(file?.status ?? ''))
        ? 'addition'
        : origin.side === 'base' &&
            (removed.has(number) || ['D', 'deleted', 'removed'].includes(file?.status ?? ''))
          ? 'deletion'
          : 'context');
    rows.push({
      text: value,
      kind,
      native: true,
      left:
        kind === 'addition'
          ? null
          : origin.side === 'base'
            ? number
            : (known?.left ?? number + shift),
      right:
        kind === 'deletion'
          ? null
          : origin.side === 'head'
            ? number
            : (known?.right ?? number + shift),
      evidence: { ...origin, startLine: number, endLine: number },
    });
  });
  rows.push(...(inserted.get(lines.length + 1) ?? []));
  return rows;
}

/** Deleted comparison lines belong to the previous PR head, never its merge-base. */
export function reviewDiffRows(
  text: string,
  origin: Evidence,
  file: ChangedFile,
  previousPath: string,
): SourceDiffRow[] {
  return sourceDiffRows(text, origin, file).map((row) =>
    row.native
      ? row
      : {
          ...row,
          historical: true,
          evidence: { ...row.evidence, side: 'head', path: previousPath },
        },
  );
}
