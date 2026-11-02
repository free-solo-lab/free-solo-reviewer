import type {
  ChangedFile,
  IndexedMethod,
  ReviewTest,
  ReviewUpdate,
  Snapshot,
  SourceIndex,
} from './model.js';
import { allTestMethods, testMatchesMethod, isTestPath } from './test-coverage.js';
import { touchesReviewChanges } from './scenario-changes.js';
import { t, tc } from './i18n.js';

export type ReviewMark = 'added' | 'modified' | 'removed' | 'renamed';
export const reviewMarkLabels: Record<ReviewMark, string> = {
  added: t('New'),
  modified: tc('migration', 'Modified'),
  removed: tc('migration', 'Removed'),
  renamed: t('Renamed'),
};
export const reviewFileKey = (repoId: string, path: string) => JSON.stringify([repoId, path]);
export function fileReviewMark(file: ChangedFile): ReviewMark {
  const status = file.status[0]?.toUpperCase();
  return status === 'A' || status === 'C'
    ? 'added'
    : status === 'D'
      ? 'removed'
      : status === 'R'
        ? 'renamed'
        : 'modified';
}
export function fileReviewMarks(changes: ReviewUpdate['changes']) {
  const marks = new Map<string, ReviewMark>();
  for (const change of changes)
    for (const file of change.files) {
      marks.set(reviewFileKey(change.repoId, file.path), fileReviewMark(file));
      if (file.oldPath) marks.set(reviewFileKey(change.repoId, file.oldPath), fileReviewMark(file));
    }
  return marks;
}
type TestReview = { snapshots: Snapshot[]; indexes: SourceIndex[]; tests: ReviewTest[] };
const normalize = (name: string) => name.replace(/`/g, '').replace(/\(\)$/, '').trim();
export function testReviewMarks(
  previous: TestReview,
  current: TestReview,
  changes: ReviewUpdate['changes'],
) {
  const result = new Map<string, ReviewMark>();
  const canonical = (repoId: string, path: string) =>
    changes.find((change) => change.repoId === repoId)?.files.find((file) => file.oldPath === path)
      ?.path ?? path;
  const methodKey = (method: IndexedMethod) =>
    JSON.stringify([
      method.evidence.repoId,
      canonical(method.evidence.repoId, method.evidence.path),
      normalize(method.name),
    ]);
  const before = allTestMethods(previous.snapshots, previous.indexes).filter(
    (method) => method.evidence.side === 'head',
  );
  const after = allTestMethods(current.snapshots, current.indexes).filter(
    (method) => method.evidence.side === 'head',
  );
  const helperEvidence = (method: IndexedMethod) => {
    const helpers = current.indexes
      .flatMap((index) => index.methods)
      .filter(
        (helper) =>
          helper.evidence.repoId === method.evidence.repoId &&
          helper.evidence.path === method.evidence.path &&
          helper.evidence.side === 'head' &&
          !helper.annotations.some((annotation) =>
            /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(
              annotation,
            ),
          ),
      );
    const seen = new Set<IndexedMethod>();
    const visit = (caller: IndexedMethod) => {
      for (const helper of helpers)
        if (
          !seen.has(helper) &&
          caller.calls.some((call) => call.split('.').at(-1) === helper.name)
        ) {
          seen.add(helper);
          visit(helper);
        }
    };
    visit(method);
    for (const helper of helpers)
      if (
        helper.annotations.some((annotation) =>
          /@(?:[\w.]+\.)?(?:BeforeEach|BeforeAll|Before|BeforeClass)\b/.test(annotation),
        )
      ) {
        seen.add(helper);
        visit(helper);
      }
    return [...seen].map((helper) => helper.evidence);
  };
  const annotate = (method: IndexedMethod, tests: ReviewTest[], mark: ReviewMark) => {
    for (const test of tests) if (testMatchesMethod(test, method)) result.set(test.id, mark);
  };
  const matched = new Set<IndexedMethod>();
  for (const method of after) {
    const candidates = before.filter(
      (old) => !matched.has(old) && methodKey(old) === methodKey(method),
    );
    const old =
      candidates.find((old) => old.signature === method.signature) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (old) matched.add(old);
    const changed = changes
      .find((change) => change.repoId === method.evidence.repoId)
      ?.files.find((file) => file.path === method.evidence.path);
    const testRefs = current.tests
      .filter((test) => testMatchesMethod(test, method))
      .flatMap((test) => [
        ...test.evidence,
        ...test.steps.flatMap((step) => [
          ...step.evidence,
          ...step.data.flatMap((data) => data.evidence),
        ]),
      ])
      .filter((ref) => isTestPath(ref.path));
    let mark: ReviewMark | undefined;
    if (!old && changed && touchesReviewChanges([method.evidence], changes)) mark = 'added';
    else if (
      old &&
      (touchesReviewChanges([method.evidence, ...testRefs, ...helperEvidence(method)], changes) ||
        old.signature !== method.signature)
    )
      mark = 'modified';
    else if (old && changed?.oldPath && changed.oldPath !== changed.path) mark = 'renamed';
    if (mark) {
      annotate(method, current.tests, mark);
      if (old) annotate(old, previous.tests, mark);
    }
  }
  for (const old of before.filter((old) => !matched.has(old))) {
    const change = changes
      .find((change) => change.repoId === old.evidence.repoId)
      ?.files.find((file) => (file.oldPath ?? file.path) === old.evidence.path);
    if (
      change &&
      (fileReviewMark(change) === 'removed' ||
        change.removedLines.some(
          (line) => line >= old.evidence.startLine && line <= old.evidence.endLine,
        ))
    )
      annotate(old, previous.tests, 'removed');
  }
  return result;
}
