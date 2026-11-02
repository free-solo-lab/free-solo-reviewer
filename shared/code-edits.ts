import { startsLike, t } from './i18n.js';
/** Keep review line anchors stable while editing their current text (including newlines). */
export function codeLineChunks(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [''];
}

export function editableLineChunks(original: string, current: string): string[] {
  const before = codeLineChunks(original),
    after = codeLineChunks(current);
  const chunks = before.map(() => '');
  let first = 0;
  while (first < Math.min(before.length, after.length) && before[first] === after[first]) {
    chunks[first] = before[first];
    first++;
  }
  let left = before.length,
    right = after.length;
  while (left > first && right > first && before[left - 1] === after[right - 1]) {
    chunks[--left] = after[--right];
  }
  const anchors: [number, number][] = [];
  const n = left - first,
    m = right - first;
  // Bound memory and time for large files; the fallback still preserves all working text.
  if (n * m <= 1_000_000) {
    const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let a = n - 1; a >= 0; a--)
      for (let b = m - 1; b >= 0; b--)
        rows[a][b] =
          before[first + a] === after[first + b]
            ? rows[a + 1][b + 1] + 1
            : Math.max(rows[a + 1][b], rows[a][b + 1]);
    let a = 0,
      b = 0;
    while (a < n && b < m) {
      if (before[first + a] === after[first + b]) {
        anchors.push([first + a++, first + b++]);
      } else if (rows[a + 1][b] >= rows[a][b + 1]) a++;
      else b++;
    }
  }
  let a = first,
    b = first;
  const fill = (endA: number, endB: number) => {
    while (a < endA && b < endB) chunks[a++] = after[b++];
    a = endA;
    if (b < endB) {
      // Insertions between original rows belong to the preceding anchor.
      const at = Math.max(0, endA - 1);
      chunks[at] += after.slice(b, endB).join('');
      b = endB;
    }
  };
  for (const [anchorA, anchorB] of anchors) {
    fill(anchorA, anchorB);
    chunks[anchorA] += after[anchorB];
    a = anchorA + 1;
    b = anchorB + 1;
  }
  fill(left, right);
  // A pure insertion at the start belongs before the first unchanged row.
  if (left === 0 && right > 0 && before[0]) chunks[0] = after.slice(0, right).join('') + before[0];
  return chunks;
}

export function replaceCodeChunk(chunks: string[], line: number, value: string): string[] {
  return chunks.map((chunk, index) => (index === line - 1 ? value : chunk));
}

/** Editing a PR needs its branch in the working folder; the page then offers to switch to it. */
const WRONG_BRANCH = 'Code editing is unavailable: the working folder is not on branch {0}.';
export const wrongBranchMessage = (branch: string) => t(WRONG_BRANCH, branch);
export const isWrongBranch = (message: string) => startsLike(message, WRONG_BRANCH);
