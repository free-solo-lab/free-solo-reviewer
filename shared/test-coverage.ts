import type { IndexedMethod, ReviewTest, Snapshot, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';
import { onHead, relevantTestMethods, testPath } from './analysis-scope.js';

export const isTestPath = testPath;
const normalize = (name: string) => name.replace(/`/g, '').replace(/\(\)$/, '').trim();
export function testMatchesMethod(test: ReviewTest, method: IndexedMethod): boolean {
  const name = normalize(test.method),
    target = normalize(method.name);
  return (
    (name === target || name.endsWith(`.${target}`)) &&
    test.evidence.some((ref) => overlaps(ref, method.evidence))
  );
}

/** One entry per annotated test method, including parameterized tests; exclude setup/helpers. */
export function allTestMethods(snapshots: Snapshot[], indexes: SourceIndex[]): IndexedMethod[] {
  const tests = indexes
    .flatMap((index) => index.methods)
    .filter((method) => {
      const ref = method.evidence,
        snapshot = snapshots.find((s) => s.repoId === ref.repoId);
      return (
        snapshot &&
        (ref.side === 'head' || !onHead(snapshot, ref.path)) &&
        isTestPath(ref.path) &&
        method.annotations.some((annotation) =>
          /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(
            annotation,
          ),
        )
      );
    });
  return tests;
}

export function missingTestMethods(
  snapshots: Snapshot[],
  indexes: SourceIndex[],
  tests: ReviewTest[],
): IndexedMethod[] {
  return reviewTestMethods(snapshots, indexes).filter(
    (method) => !tests.some((test) => testMatchesMethod(test, method)),
  );
}

export function reviewTestMethods(snapshots: Snapshot[], indexes: SourceIndex[]): IndexedMethod[] {
  return relevantTestMethods(snapshots, indexes, allTestMethods(snapshots, indexes));
}
