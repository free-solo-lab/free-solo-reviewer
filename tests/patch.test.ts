import { describe, expect, it } from 'vitest';
import { parseHunkHeader, patchLines, tailHunk } from '../shared/patch';

describe('unified diff parsing', () => {
  it('reads hunk headers with omitted and empty counts', () => {
    expect(parseHunkHeader('@@ -3 +4,0 @@ class A')).toEqual({
      oldStart: 3,
      oldCount: 1,
      newStart: 4,
      newCount: 0,
    });
    expect(parseHunkHeader('diff --git a/A b/A')).toBeNull();
  });
  it('numbers changed and context lines on both sides', () => {
    const patch = [
      '--- a/A.java',
      '+++ b/A.java',
      '@@ -2,3 +2,3 @@',
      ' keep',
      '-old',
      '+new',
      ' tail',
      '\\ No newline at end of file',
    ].join('\n');
    expect(
      [...patchLines(patch)].map((line) =>
        'oldLine' in line ? [line.kind, line.oldLine, line.newLine] : [line.kind],
      ),
    ).toEqual([
      ['meta'],
      ['meta'],
      ['hunk'],
      ['context', 2, 2],
      ['deletion', 3, 3],
      ['addition', 4, 3],
      ['context', 4, 4],
      ['meta'],
    ]);
  });
  it('keeps the last lines of a comment hunk with a header that numbers them right', () => {
    const hunk = '@@ -10,5 +10,5 @@ class A\n a\n-b\n+B\n c\n+d\n e';
    expect(tailHunk(hunk, 10)).toBe(hunk);
    const tail = tailHunk(hunk, 3);
    expect(tail).toBe('@@ -12,2 +12,3 @@\n c\n+d\n e');
    expect([...patchLines(tail)].filter((line) => line.kind === 'context')).toMatchObject([
      { oldLine: 12, newLine: 12 },
      { oldLine: 13, newLine: 14 },
    ]);
  });
});
