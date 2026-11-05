/** Unchanged lines shown around each change, as in GitHub's diff. */
export const FOLD_CONTEXT = 3;
/** Lines revealed by one click on an expand arrow. */
export const FOLD_STEP = 20;
/** Shorter runs are shown as they are: an expander would take as much room. */
export const FOLD_MIN = 4;

/** A run of hidden unchanged rows, by row index (inclusive). */
export interface SourceFold {
  start: number;
  end: number;
}
/** Rows revealed so far from the top and the bottom of a fold. */
export interface FoldReveal {
  top: number;
  bottom: number;
}
export interface FoldRow {
  kind: 'addition' | 'deletion' | 'context';
}

/**
 * Unchanged regions far from every change. A file without changes is shown whole.
 * `pinned` rows (comments, the selection, headers of changed methods) always stay visible.
 */
export function sourceFolds(
  rows: FoldRow[],
  pinned: (index: number) => boolean = () => false,
): SourceFold[] {
  const changes = rows.flatMap((row, i) => (row.kind === 'context' ? [] : [i]));
  if (!changes.length) return [];
  const near = new Array<boolean>(rows.length).fill(false);
  for (const i of changes)
    for (
      let j = Math.max(0, i - FOLD_CONTEXT);
      j <= Math.min(rows.length - 1, i + FOLD_CONTEXT);
      j++
    )
      near[j] = true;
  const folds: SourceFold[] = [];
  let current: SourceFold | undefined;
  rows.forEach((_row, i) => {
    const hidden = !near[i] && !pinned(i);
    if (hidden && current) current.end = i;
    else if (hidden) folds.push((current = { start: i, end: i }));
    else current = undefined;
  });
  return folds.filter((fold) => fold.end - fold.start + 1 >= FOLD_MIN);
}

/** The rows of a fold that are still hidden after expanding, or null when it is fully open. */
export function hiddenRange(fold: SourceFold, reveal: FoldReveal = { top: 0, bottom: 0 }) {
  const start = fold.start + reveal.top,
    end = fold.end - reveal.bottom;
  return start <= end ? { start, end } : null;
}

/**
 * Which arrows a fold offers. At the top of the file only "up" (towards the first change),
 * at the end only "down"; between changes both, or one "all" when one step would open it.
 */
export function foldActions(fold: SourceFold, rowCount: number, reveal?: FoldReveal) {
  const range = hiddenRange(fold, reveal);
  if (!range) return [];
  const size = range.end - range.start + 1;
  const first = fold.start === 0,
    last = fold.end === rowCount - 1;
  if (first) return [size <= FOLD_STEP ? 'all' : 'up'] as const;
  if (last) return [size <= FOLD_STEP ? 'all' : 'down'] as const;
  return size <= FOLD_STEP ? (['all'] as const) : (['down', 'up'] as const);
}

/** Reveal one step: "down" continues the code above the fold, "up" the code below it. */
export function expandFold(
  fold: SourceFold,
  reveal: FoldReveal = { top: 0, bottom: 0 },
  action: 'up' | 'down' | 'all',
): FoldReveal {
  const size = fold.end - fold.start + 1;
  if (action === 'all') return { top: size, bottom: 0 };
  return action === 'down'
    ? { ...reveal, top: Math.min(size, reveal.top + FOLD_STEP) }
    : { ...reveal, bottom: Math.min(size, reveal.bottom + FOLD_STEP) };
}
