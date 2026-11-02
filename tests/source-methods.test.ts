import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sourceDiffRows } from '../shared/source-diff';
import { sourceMethodRows } from '../shared/source-methods';
import { SourceCode } from '../web/components';
import { TooltipProvider } from '../web/ui/Tooltip';
import type { ChangedFile, Evidence } from '../shared/model';
import type { MethodView } from '../shared/viewed-methods';

const evidence: Evidence = {
  repoId: 'repo',
  path: 'Service.java',
  side: 'head',
  startLine: 1,
  endLine: 1,
};
const text =
  'class Service {\n  String first() {\n    return "new";\n  }\n  String second() {\n    return "keep";\n  }\n}';
const changed: ChangedFile = {
  path: 'Service.java',
  status: 'M',
  addedLines: [3],
  removedLines: [3],
  patch:
    '@@ -1,8 +1,8 @@\n class Service {\n   String first() {\n-    return "old";\n+    return "new";\n   }\n   String second() {\n     return "keep";\n   }\n }',
};
const methods: MethodView[] = [
  {
    key: 'first',
    viewed: true,
    method: {
      name: 'first',
      signature: 'String first()',
      calls: [],
      annotations: [],
      evidence: { ...evidence, startLine: 2, endLine: 4 },
    },
  },
  {
    key: 'second',
    viewed: false,
    method: {
      name: 'second',
      signature: 'String second()',
      calls: [],
      annotations: [],
      evidence: { ...evidence, startLine: 5, endLine: 7 },
    },
  },
];
describe('method folding in shared source review', () => {
  it('offers inline deletion for editable comments and hides it in read-only code', () => {
    const props = {
      text,
      evidence,
      onSelect() {},
      comments: [
        {
          id: 'note',
          body: 'Saved note',
          selected: true,
          evidence: { ...evidence, startLine: 3, endLine: 3 },
        },
      ],
    };
    // The delete action has a tooltip, which needs the provider the app mounts at its root.
    const editable = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(SourceCode, { ...props, onDeleteComment() {} }),
      ),
    );
    expect(editable).toContain('aria-label="Удалить комментарий"');
    expect(editable).toContain('Saved note');
    const readOnly = renderToStaticMarkup(React.createElement(SourceCode, props));
    expect(readOnly).toContain('Saved note');
    expect(readOnly).not.toContain('aria-label="Удалить комментарий"');
  });

  it('keeps deleted diff lines inside their method so they fold with added lines', () => {
    const rows = sourceMethodRows(sourceDiffRows(text, evidence, changed), methods);
    expect(
      rows.filter((entry) => entry.row.kind === 'deletion').map((entry) => entry.method?.key),
    ).toEqual(['first']);
    expect(rows.filter((entry) => entry.methodStart).map((entry) => entry.method?.key)).toEqual([
      'first',
      'second',
    ]);
  });
  it('folds reviewed method bodies, preserves other methods and offers access to comments', () => {
    const html = renderToStaticMarkup(
      React.createElement(SourceCode, {
        text,
        evidence,
        changedFile: changed,
        methods,
        onSelect() {},
        comments: [
          {
            id: 'comment',
            body: 'Review note',
            selected: true,
            evidence: { ...evidence, startLine: 3, endLine: 3 },
          },
        ],
      }),
    );
    expect(html).toContain('first()');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('&quot;old&quot;');
    expect(html).not.toContain('&quot;new&quot;');
    expect(html).toContain('&quot;keep&quot;');
    expect(html).toContain('Показать комментарии');
  });
});
