import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { sourceChangeBlocks, nextSourceChange } from '../shared/source-changes';
import { sourceDiffRows, reviewDiffRows } from '../shared/source-diff';
import type { ChangedFile, Evidence, Snapshot } from '../shared/model';
import { SourceCode } from '../web/components';
import { ChangedFilesMenu } from '../web/ChangedFilesMenu';

const evidence: Evidence = { repoId: 'r', path: 'A.java', side: 'head', startLine: 1, endLine: 1 };
const file: ChangedFile = {
  path: 'A.java',
  status: 'M',
  addedLines: [2],
  removedLines: [2, 5],
  patch: '@@ -1,6 +1,5 @@\n first\n-old\n+new\n middle\n context\n-deleted\n last',
};
const text = 'first\nnew\nmiddle\ncontext\nlast\n';
it('groups adjacent added and removed lines, including deletion-only changes and past-review diffs', () => {
  const rows = sourceDiffRows(text, evidence, file);
  expect(sourceChangeBlocks(rows)).toEqual([
    { start: 1, end: 2 },
    { start: 5, end: 5 },
  ]);
  expect(sourceChangeBlocks(reviewDiffRows(text, evidence, file, 'Old.java'))).toHaveLength(2);
  expect(sourceChangeBlocks(rows, new Set([5]))).toEqual([
    { start: 1, end: 2 },
    { start: 5, end: 6 },
  ]);
  expect(
    sourceChangeBlocks(
      sourceDiffRows('', evidence, {
        ...file,
        status: 'D',
        addedLines: [],
        patch: '@@ -1,1 +0,0 @@\n-removed',
      }),
    ),
  ).toHaveLength(1);
  expect(sourceChangeBlocks(sourceDiffRows(text, evidence))).toEqual([]);
});
it('cycles through changes and handles an empty file or first navigation', () => {
  expect(nextSourceChange(-1, 1, 3)).toBe(0);
  expect(nextSourceChange(-1, -1, 3)).toBe(2);
  expect(nextSourceChange(2, 1, 3)).toBe(0);
  expect(nextSourceChange(0, -1, 3)).toBe(2);
  expect(nextSourceChange(0, 1, 0)).toBe(-1);
  expect(nextSourceChange(0, 1, 1)).toBe(0);
});
it('renders shared change arrows with the change count', () => {
  const html = renderToStaticMarkup(
    React.createElement(SourceCode, { text, evidence, changedFile: file, onSelect() {} }),
  );
  expect(html).toContain('aria-label="Предыдущее изменение"');
  expect(html).toContain('aria-label="Следующее изменение"');
  expect(html).toContain('2 изм.');
});
it('defaults to changed and unviewed files in the compact project filters', () => {
  const snapshot = {
    id: 's',
    repoId: 'r',
    repoName: 'Repo',
    slug: 'local/repo',
    files: [file, { ...file, path: 'Viewed.java' }],
    headFiles: ['A.java', 'Unchanged.java', 'Viewed.java'],
    baseFiles: [],
  } as unknown as Snapshot;
  const html = renderToStaticMarkup(
    React.createElement(ChangedFilesMenu, {
      snapshots: [snapshot],
      snapshot,
      selectedPath: 'A.java',
      onSelect() {},
      isViewed: (_snapshot, path) => path === 'Viewed.java',
      isViewPending: () => false,
      viewLoading: false,
      onViewed() {},
    }),
  );
  expect(html).toMatch(/aria-label="Только изменённые файлы"[^>]*checked=""/);
  expect(html).toMatch(/aria-label="Скрыть просмотренные файлы"[^>]*checked=""/);
  expect(html).toContain('A.java');
  expect(html).not.toContain('Unchanged.java');
  expect(html).not.toContain('Viewed.java');
});
it('shows only files changed since the review when that version is chosen', () => {
  const snapshot = {
    id: 's',
    repoId: 'r',
    repoName: 'Repo',
    slug: 'local/repo',
    files: [file, { ...file, path: 'Fixed.java' }],
    headFiles: ['A.java', 'Fixed.java'],
    baseFiles: [],
  } as unknown as Snapshot;
  const props = {
    snapshots: [snapshot],
    snapshot,
    onSelect() {},
    isViewed: () => false,
    isViewPending: () => false,
    viewLoading: false,
    onViewed() {},
    revisionChanges: [
      { repoId: 'r', fromSha: 'a', toSha: 'b', files: [{ ...file, path: 'Fixed.java' }] },
    ],
  };
  const all = renderToStaticMarkup(React.createElement(ChangedFilesMenu, props));
  expect(all).toContain('A.java');
  const since = renderToStaticMarkup(
    React.createElement(ChangedFilesMenu, { ...props, sinceReview: true }),
  );
  expect(since).toContain('Fixed.java');
  expect(since).not.toContain('A.java');
  expect(since).toContain('С ревью');
  expect(since).toContain('1/2');
});
