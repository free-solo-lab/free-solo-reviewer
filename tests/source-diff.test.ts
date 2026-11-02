import { describe, it, expect } from 'vitest';
import { sourceDiffRows } from '../shared/source-diff';
import type { ChangedFile, Evidence } from '../shared/model';
const origin: Evidence = {
  repoId: 'repo',
  side: 'head',
  path: 'Service.kt',
  startLine: 3,
  endLine: 8,
};
const file = (patch: string): ChangedFile => ({
  path: 'Service.kt',
  patch,
  status: 'M',
  addedLines: [],
  removedLines: [],
});
const replacement = file('@@ -1,3 +1,3 @@\n one\n-old\n+new\n three');
describe('full source with PR diff coloring', () => {
  it('shows deletion and addition together without coloring surrounding source', () => {
    const rows = sourceDiffRows('one\nnew\nthree\n', origin, replacement);
    expect(rows.map((r) => [r.text, r.kind, r.left, r.right])).toEqual([
      ['one', 'context', 1, 1],
      ['old', 'deletion', 2, null],
      ['new', 'addition', null, 2],
      ['three', 'context', 3, 3],
    ]);
    expect(rows[1].evidence).toMatchObject({ side: 'base', startLine: 2, endLine: 2 });
    expect(rows[2].evidence).toMatchObject({ side: 'head', startLine: 2, endLine: 2 });
  });
  it('also shows both kinds of changes when opened at a base-side location', () => {
    const rows = sourceDiffRows('one\nold\nthree\n', { ...origin, side: 'base' }, replacement);
    expect(rows.map((r) => r.text)).toEqual(['one', 'old', 'new', 'three']);
    expect(rows.map((r) => r.native)).toEqual([true, true, false, true]);
  });
  it('does not treat the selected method range as a changed block', () => {
    const first = sourceDiffRows('one\nnew\nthree\n', origin, replacement);
    const second = sourceDiffRows(
      'one\nnew\nthree\n',
      { ...origin, startLine: 1, endLine: 1 },
      replacement,
    );
    expect(second).toEqual(first);
  });
  it('keeps context outside hunks and maps line numbers after insertions', () => {
    const rows = sourceDiffRows(
      'one\ninserted\ntwo\nthree\n',
      origin,
      file('@@ -1,2 +1,3 @@\n one\n+inserted\n two'),
    );
    expect(rows.at(-1)).toMatchObject({ text: 'three', left: 3, right: 4, kind: 'context' });
  });
  it('handles zero-length insertion hunks after the correct base line', () => {
    const rows = sourceDiffRows(
      'one\ntwo\nthree\n',
      { ...origin, side: 'base' },
      file('@@ -2,0 +3 @@\n+new'),
    );
    expect(rows.map((r) => r.text)).toEqual(['one', 'two', 'new', 'three']);
    expect(rows.at(-1)).toMatchObject({ left: 3, right: 4 });
  });
  it('handles zero-length deletion hunks after the correct head line', () => {
    const rows = sourceDiffRows('one\ntwo\nthree\n', origin, file('@@ -3 +2,0 @@\n-old'));
    expect(rows.map((r) => r.text)).toEqual(['one', 'two', 'old', 'three']);
    expect(rows.at(-1)).toMatchObject({ left: 4, right: 3 });
  });
  it('handles a fully added file from an empty base', () => {
    const changed = { ...file('@@ -0,0 +1,2 @@\n+one\n+two'), status: 'A' };
    expect(sourceDiffRows('one\ntwo\n', origin, changed).every((r) => r.kind === 'addition')).toBe(
      true,
    );
    expect(sourceDiffRows('', { ...origin, side: 'base' }, changed).map((r) => r.text)).toEqual([
      'one',
      'two',
    ]);
  });
  it('handles a fully removed file from an empty head', () => {
    const changed = { ...file('@@ -1,2 +0,0 @@\n-one\n-two'), status: 'D' };
    const rows = sourceDiffRows('', origin, changed);
    expect(rows.map((r) => r.text)).toEqual(['one', 'two']);
    expect(rows.every((r) => r.kind === 'deletion' && r.evidence.side === 'base')).toBe(true);
  });
  it('keeps original paths for comments on renamed deleted lines', () => {
    const rows = sourceDiffRows('one\nnew\nthree\n', origin, {
      ...replacement,
      oldPath: 'OldService.kt',
    });
    expect(rows[1].evidence.path).toBe('OldService.kt');
    expect(rows[2].evidence.path).toBe('Service.kt');
  });
  it('keeps unchanged files neutral, ignoring navigation targets', () => {
    expect(sourceDiffRows('one\ntwo\n', origin).map((r) => r.kind)).toEqual(['context', 'context']);
  });
  it('inserts changes at EOF and ignores no-newline markers', () => {
    const rows = sourceDiffRows(
      'one',
      origin,
      file('@@ -1,2 +1 @@\n one\n-old\n\\ No newline at end of file'),
    );
    expect(rows.map((r) => r.text)).toEqual(['one', 'old']);
  });
});
