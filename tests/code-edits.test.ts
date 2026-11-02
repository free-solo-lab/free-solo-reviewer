import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { codeLineChunks, editableLineChunks, replaceCodeChunk } from '../shared/code-edits';
import { indentRange, rangeText, replaceRange, step } from '../web/workspace/editable-code';
import { SourceCode } from '../web/components';

describe('inline review edits', () => {
  it('preserves all working text and keeps unchanged review anchors, including existing working edits', () => {
    const cases = [
      ['', ''],
      ['', 'new\ntext'],
      ['a\nb\nc\n', 'a\nnew\nc\n'],
      ['a\nb\n', 'prefix\na\nb\n'],
      ['a\nb\n', 'a\nadded\nb\n'],
      ['a\nb\n', 'a\nb\nlast\n'],
      ['a\nb\n', 'a\n'],
      ['a\n', ''],
      ['a\r\nb\r\n', 'a\r\nchanged\r\n'],
      ['a', 'a\n'],
      ['a\n', 'a'],
    ];
    for (const [original, current] of cases) {
      const chunks = editableLineChunks(original, current);
      expect(chunks.join('')).toBe(current);
      expect(chunks).toHaveLength(codeLineChunks(original).length);
    }
    expect(editableLineChunks('a\nb\nc\n', 'a\nnew\nc\n')[2]).toBe('c\n');
    expect(replaceCodeChunk(['a\n', 'b\n'], 1, 'new\nsecond\n').join('')).toBe('new\nsecond\nb\n');
  });
  it('never drops text with arbitrary insertions, removals or repeated lines', () => {
    let seed = 42;
    const rand = () => (seed = (1664525 * seed + 1013904223) >>> 0) % 8;
    for (let sample = 0; sample < 500; sample++) {
      const original = Array.from({ length: rand() + 1 }, () => `line${rand()}\n`).join('');
      const current = Array.from({ length: rand() + 1 }, () => `line${rand()}\n`).join('');
      expect(editableLineChunks(original, current).join('')).toBe(current);
    }
    const big = Array.from({ length: 1200 }, (_, i) => `old${i}\n`).join('');
    const current = big.replaceAll('old', 'new');
    expect(editableLineChunks(big, current).join('')).toBe(current);
  });
  it('edits across lines like one text while every line keeps its anchor', () => {
    const chunks = ['class A {\n', '  int a;\n', '  int b;\n', '}\n'];
    // Select from the middle of line 2 to the middle of line 3 and paste two lines.
    const pasted = replaceRange(
      chunks,
      { line: 2, offset: 6 },
      { line: 3, offset: 7 },
      'x;\n  int y',
    );
    expect(pasted.chunks.join('')).toBe('class A {\n  int x;\n  int y;\n}\n');
    expect(pasted.chunks).toHaveLength(4);
    expect(pasted.chunks[2]).toBe('');
    expect(pasted.caret).toEqual({ line: 2, start: 16, end: 16 });
    expect(rangeText(chunks, { line: 1, offset: 6 }, { line: 3, offset: 5 })).toBe(
      'A {\n  int a;\n  int',
    );
    // Backspace at the start of a line joins it with the previous non-empty line.
    const joined = replaceRange(
      pasted.chunks,
      step(pasted.chunks, { line: 4, offset: 0 }, -1),
      {
        line: 4,
        offset: 0,
      },
      '',
    );
    expect(joined.chunks.join('')).toBe('class A {\n  int x;\n  int y;}\n');
    expect(step(pasted.chunks, { line: 2, offset: 17 }, 1)).toEqual({ line: 4, offset: 0 });
  });
  it('indents and outdents every selected line, inside grown lines too', () => {
    const chunks = ['a\n', 'b\nc\n', 'd\n'];
    const indented = indentRange(chunks, { line: 2, offset: 0 }, { line: 3, offset: 1 }, false);
    expect(indented).toEqual(['a\n', '    b\n    c\n', '    d\n']);
    expect(indentRange(indented, { line: 2, offset: 0 }, { line: 2, offset: 0 }, true)).toEqual([
      'a\n',
      'b\n    c\n',
      '    d\n',
    ]);
  });
  it('keeps deleted lines read-only and comments alongside editable head lines', () => {
    const evidence = {
      repoId: 'repo',
      path: 'A.java',
      side: 'head' as const,
      startLine: 1,
      endLine: 1,
    };
    const html = renderToStaticMarkup(
      React.createElement(SourceCode, {
        text: 'new\nnext\n',
        evidence,
        onSelect: () => {},
        toolbarActions: React.createElement('label', null, 'Просмотрен'),
        changedFile: {
          path: 'A.java',
          status: 'M',
          addedLines: [1],
          removedLines: [1],
          patch: '@@ -1,2 +1,2 @@\n-old\n+new\n next',
        },
        inlineEditing: {
          chunks: ['changed\n', 'next\n'],
          onEdit: () => {},
          onSave: () => {},
        },
        comments: [{ id: 'comment', body: 'Existing discussion', selected: true, evidence }],
      }),
    );
    expect(html.match(/data-edit-line=/g)).toHaveLength(2);
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain('Existing discussion');
    expect(html).toContain('source-line deletion');
    expect(html).toContain('changed');
    expect(html).toContain('source-toolbar-actions');
    expect(html).toContain('Просмотрен');
    expect(html).not.toContain('+ Добавлено');
    expect(html).not.toContain('Потяни за номер строки');
    expect(html).not.toContain('Markdown');
  });
});
