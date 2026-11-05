import { describe, expect, it } from 'vitest';
import {
  expandFold,
  foldActions,
  hiddenRange,
  sourceFolds,
  FOLD_STEP,
  type FoldRow,
} from '../shared/source-folds';

const file = (length: number, changed: number[]): FoldRow[] =>
  Array.from({ length }, (_, i) => ({ kind: changed.includes(i) ? 'addition' : 'context' }));

describe('folding unchanged code like GitHub', () => {
  it('hides code before, between and after changes, keeping three lines around each', () => {
    const rows = file(100, [10, 60]);
    expect(sourceFolds(rows)).toEqual([
      { start: 0, end: 6 },
      { start: 14, end: 56 },
      { start: 64, end: 99 },
    ]);
  });
  it('shows a file without changes and short gaps whole', () => {
    expect(sourceFolds(file(50, []))).toEqual([]);
    // Only lines 5..7 are far from both changes.
    expect(sourceFolds(file(13, [1, 11]))).toEqual([]);
    // A three-line run is not worth an expander.
    expect(sourceFolds(file(5, [4]))).toEqual([]);
  });
  it('keeps pinned rows visible', () => {
    const rows = file(40, [0]);
    expect(sourceFolds(rows, (i) => i === 20)).toEqual([
      { start: 4, end: 19 },
      { start: 21, end: 39 },
    ]);
  });
  it('offers the arrows by position and reveals twenty lines per click', () => {
    const rows = file(200, [100]);
    const [top, bottom] = sourceFolds(rows);
    expect(foldActions(top, rows.length)).toEqual(['up']);
    expect(foldActions(bottom, rows.length)).toEqual(['down']);
    const middle = { start: 10, end: 80 };
    expect(foldActions(middle, rows.length)).toEqual(['down', 'up']);
    let reveal = expandFold(middle, undefined, 'down');
    reveal = expandFold(middle, reveal, 'up');
    expect(hiddenRange(middle, reveal)).toEqual({ start: 10 + FOLD_STEP, end: 80 - FOLD_STEP });
    expect(foldActions(middle, rows.length, reveal)).toEqual(['down', 'up']);
    reveal = expandFold(middle, reveal, 'down');
    expect(foldActions(middle, rows.length, reveal)).toEqual(['all']);
    expect(hiddenRange(middle, expandFold(middle, reveal, 'all'))).toBeNull();
    expect(foldActions(middle, rows.length, expandFold(middle, reveal, 'all'))).toEqual([]);
  });
});
