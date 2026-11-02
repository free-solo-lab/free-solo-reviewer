import type { IndexedMethod, ReviewTest, Snapshot, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';

export const isTestPath = (path: string) =>
  /(?:^|\/)(?:test|tests)\/|(?:Test|Tests|Spec)\.(?:java|kt)$/.test(path);
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
export function reviewTestMethods(snapshots: Snapshot[], indexes: SourceIndex[]): IndexedMethod[] {
  return indexes
    .flatMap((index) => index.methods)
    .filter((method) => {
      const ref = method.evidence,
        snapshot = snapshots.find((s) => s.repoId === ref.repoId);
      return (
        snapshot &&
        (ref.side === 'head' || !snapshot.headFiles.includes(ref.path)) &&
        isTestPath(ref.path) &&
        method.annotations.some((annotation) =>
          /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(
            annotation,
          ),
        )
      );
    });
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
