import { describe, expect, it } from 'vitest';
import { fileReviewMarks, reviewFileKey, testReviewMarks } from '../shared/review-markers';
import type {
  ChangedFile,
  IndexedMethod,
  ReviewTest,
  ReviewUpdate,
  Snapshot,
  SourceIndex,
} from '../shared/model';

const path = 'src/test/ReaderTest.kt';
const method = (name: string, startLine: number, file = path): IndexedMethod => ({
  name,
  signature: `fun ${name}()`,
  annotations: ['@Test'],
  calls: [],
  evidence: { repoId: 'repo', side: 'head', path: file, startLine, endLine: startLine + 5 },
});
const review = (methods: IndexedMethod[], prefix: string) => ({
  snapshots: [{ repoId: 'repo', headFiles: methods.map((m) => m.evidence.path) }] as Snapshot[],
  indexes: [{ methods }] as SourceIndex[],
  tests: methods.map((m) => ({
    id: `${prefix}-${m.name}`,
    title: m.name,
    summary: m.name,
    confidence: 'extracted',
    method: m.name,
    evidence: [m.evidence],
    steps: [],
  })) as ReviewTest[],
});
const file = (extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'M',
  patch: '',
  addedLines: [12],
  removedLines: [],
  ...extra,
});
const changes = (...files: ChangedFile[]): ReviewUpdate['changes'] => [
  { repoId: 'repo', fromSha: 'old', toSha: 'new', files },
];

describe('sidebar changes since the previous review', () => {
  it('marks tests that invoke a changed local fixture helper, including nested helpers', () => {
    const before = review([method('reads', 10), method('rejects', 20)], 'old');
    const after = review([method('reads', 10), method('rejects', 20)], 'new');
    after.indexes[0].methods[0].calls = ['prepare'];
    after.indexes[0].methods.push(
      { ...method('prepare', 40), annotations: [], calls: ['enrich'] },
      { ...method('enrich', 50), annotations: [], calls: [] },
    );
    const marks = testReviewMarks(before, after, changes(file({ addedLines: [52] })));
    expect(marks.get('new-reads')).toBe('modified');
    expect(marks.get('old-reads')).toBe('modified');
    expect(marks.has('new-rejects')).toBe(false);
  });
  it('marks only changed methods and maps both old and new analysis IDs, ignoring shifted lines and rewritten titles', () => {
    const before = review([method('reads', 10), method('rejects', 20)], 'old');
    const after = review([method('reads', 10), method('rejects', 25)], 'new');
    after.tests[1].title = 'Rewritten description';
    expect([...testReviewMarks(before, after, changes(file()))]).toEqual([
      ['new-reads', 'modified'],
      ['old-reads', 'modified'],
    ]);
  });
  it('includes referenced changed setup data but ignores production changes and merge-base evidence', () => {
    const before = review([method('reads', 10)], 'old');
    const after = review([method('reads', 10)], 'new');
    after.tests[0].evidence.push({ ...method('setup', 40).evidence });
    expect(
      testReviewMarks(before, after, changes(file({ addedLines: [42] }))).get('new-reads'),
    ).toBe('modified');
    expect(testReviewMarks(before, after, changes(file({ path: 'src/main/Reader.kt' })))).toEqual(
      new Map(),
    );
    after.tests[0].evidence[1].side = 'base';
    expect(testReviewMarks(before, after, changes(file({ addedLines: [42] })))).toEqual(new Map());
  });
  it('distinguishes added, removed and renamed tests', () => {
    const before = review([method('gone', 10), method('retained', 30)], 'old');
    const after = review([method('newTest', 10), method('retained', 30)], 'new');
    const marks = testReviewMarks(
      before,
      after,
      changes(file({ addedLines: [12], removedLines: [12] })),
    );
    expect(marks.get('new-newTest')).toBe('added');
    expect(marks.get('old-gone')).toBe('removed');
    expect(marks.has('new-retained')).toBe(false);
    const renamed = review([method('retained', 30, 'src/test/RenamedTest.kt')], 'new');
    expect(
      testReviewMarks(
        review([method('retained', 30)], 'old'),
        renamed,
        changes(
          file({ path: 'src/test/RenamedTest.kt', oldPath: path, status: 'R100', addedLines: [] }),
        ),
      ).get('new-retained'),
    ).toBe('renamed');
  });
  it('marks files by repository and preserves aliases for renamed files', () => {
    const marks = fileReviewMarks(
      changes(
        file({ path: 'new.kt', oldPath: 'old.kt', status: 'R100' }),
        file({ path: 'gone.kt', status: 'D' }),
        file({ path: 'added.kt', status: 'A' }),
      ),
    );
    expect(marks.get(reviewFileKey('repo', 'old.kt'))).toBe('renamed');
    expect(marks.get(reviewFileKey('repo', 'new.kt'))).toBe('renamed');
    expect(marks.get(reviewFileKey('repo', 'gone.kt'))).toBe('removed');
    expect(marks.get(reviewFileKey('repo', 'added.kt'))).toBe('added');
    expect(marks.has(reviewFileKey('another', 'new.kt'))).toBe(false);
  });
});
