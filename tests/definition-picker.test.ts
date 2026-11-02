import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { definitionReviewChange, type MethodLink } from '../shared/code-navigation';
import type { IndexedMethod, Snapshot, SourceIndex } from '../shared/model';
import { DefinitionPicker } from '../web/workspace/DefinitionPicker';

const method: IndexedMethod = {
  owner: 'api.ContextTracer',
  name: 'beforeCall',
  signature: 'void beforeCall(Object[] args)',
  annotations: [],
  calls: [],
  evidence: {
    repoId: 'repo',
    path: 'ContextTracer.java',
    side: 'head',
    startLine: 10,
    endLine: 20,
  },
};
const snapshot = (changes: Partial<Snapshot['files'][number]> = {}): Snapshot =>
  ({
    repoId: 'repo',
    files: [
      {
        path: 'ContextTracer.java',
        status: 'M',
        patch: '',
        addedLines: [15],
        removedLines: [15],
        ...changes,
      },
    ],
  }) as Snapshot;

it('highlights changed implementations using the PR diff, distinguishing method and other file edits', () => {
  expect(definitionReviewChange(method, [snapshot()])).toEqual({
    scope: 'method',
    kind: 'modified',
  });
  expect(definitionReviewChange(method, [snapshot({ addedLines: [30] })])).toEqual({
    scope: 'file',
    kind: 'modified',
  });
  expect(definitionReviewChange(method, [snapshot({ status: 'A', addedLines: [] })])).toEqual({
    scope: 'method',
    kind: 'added',
  });
  expect(definitionReviewChange(method, [snapshot({ status: 'unchanged' })])).toBeUndefined();
  expect(
    definitionReviewChange({ ...method, evidence: { ...method.evidence, repoId: 'other' } }, [
      snapshot(),
    ]),
  ).toBeUndefined();
});
it('detects deleted-only method changes and uses the correct side of a renamed file', () => {
  expect(
    definitionReviewChange(method, [
      snapshot({ addedLines: [], patch: '@@ -14,2 +14,1 @@\n-removed();\n keep();' }),
    ])?.scope,
  ).toBe('method');
  expect(
    definitionReviewChange(method, [
      snapshot({
        addedLines: [],
        patch: '@@ -9,2 +10,1 @@\n-previousMethod();\n void beforeCall()',
      }),
    ])?.scope,
  ).toBe('file');
  const base = {
    ...method,
    evidence: { ...method.evidence, path: 'OldTracer.java', side: 'base' as const },
  };
  expect(
    definitionReviewChange(base, [
      snapshot({ status: 'R', oldPath: 'OldTracer.java', addedLines: [], removedLines: [15] }),
    ])?.scope,
  ).toBe('method');
});
it('renders an unobtrusive marker only on changed choices and preserves interface and implementation choices', () => {
  const untouched = {
    ...method,
    owner: 'api.Tracer',
    evidence: { ...method.evidence, path: 'Tracer.java' },
  };
  const link: MethodLink = {
    name: 'beforeCall',
    start: 0,
    end: 10,
    line: 25,
    requiresChoice: true,
    targets: [untouched, method],
  };
  const index = {
    repoId: 'repo',
    side: 'head',
    types: [{ qualifiedName: 'api.Tracer', kind: 'interface' }],
  } as SourceIndex;
  const html = renderToStaticMarkup(
    React.createElement(DefinitionPicker, {
      link,
      snapshots: [snapshot()],
      indexes: [index],
      onSelect() {},
      onClose() {},
    }),
  );
  expect(html).toContain('Интерфейс');
  expect(html).toContain('Класс');
  // Only the kind and the simple class name; package, signature and path stay in the tooltip.
  expect(html).toContain('Интерфейс · Tracer<');
  expect(html).not.toContain('<small>');
  expect(html.match(/data-change-scope="method"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Метод изменён в PR"');
  expect(html).toContain('review-revision-dot modified');
});
