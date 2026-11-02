import { describe, expect, it } from 'vitest';
import {
  isTestPath,
  missingTestMethods,
  reviewTestMethods,
  testMatchesMethod,
} from '../shared/test-coverage';
import type { IndexedMethod, ReviewTest, Snapshot, SourceIndex } from '../shared/model';

const method = (name: string, annotation = '@Test'): IndexedMethod => ({
  name,
  signature: `fun ${name}()`,
  annotations: [annotation],
  calls: [],
  evidence: {
    repoId: 'repo',
    side: 'head',
    path: 'src/test/ReaderTest.kt',
    startLine: 10,
    endLine: 15,
  },
});
describe('test path detection', () => {
  it('recognises test directories and Test/Tests/Spec suffixes in any source set', () => {
    for (const path of [
      'src/test/kotlin/ReaderTest.kt',
      'tests/Reader.kt',
      'test/Reader.java',
      'src/integrationTest/kotlin/ReaderTests.kt',
      'src/main/kotlin/ReaderSpec.kt',
      'web/src/components/OrderForm.test.tsx',
      'web/src/api/orders.spec.ts',
      'web/src/components/__tests__/OrderForm.tsx',
      'web/e2e/checkout.ts',
      'web/cypress/e2e/login.cy.js',
    ])
      expect(isTestPath(path), path).toBe(true);
    for (const path of [
      'src/main/kotlin/Reader.kt',
      'src/main/kotlin/TestDataFactory.kt',
      'src/main/kotlin/contest/Reader.kt',
      'web/src/components/OrderForm.tsx',
      'web/src/components/OrderForm.stories.tsx',
      'web/src/testing-library-setup.ts',
      'web/src/latest/specification.ts',
    ])
      expect(isTestPath(path), path).toBe(false);
  });
});
describe('test catalog coverage', () => {
  it('counts annotated methods including parameterized tests, excluding setup and old versions', () => {
    const first = method('`reads a record`'),
      second = method('rejects', '@org.junit.jupiter.params.ParameterizedTest');
    const old = { ...first, evidence: { ...first.evidence, side: 'base' as const } };
    const helper = method('setup', '@BeforeEach');
    const snapshots = [
      {
        repoId: 'repo',
        headFiles: [first.evidence.path],
        files: [
          { path: first.evidence.path, status: 'A', patch: '', addedLines: [10], removedLines: [] },
        ],
      },
    ] as unknown as Snapshot[];
    const indexes = [{ methods: [first, second, old, helper] }] as SourceIndex[];
    const test = { method: 'reads a record', evidence: [first.evidence] } as ReviewTest;
    expect(reviewTestMethods(snapshots, indexes)).toEqual([first, second]);
    expect(testMatchesMethod(test, first)).toBe(true);
    expect(missingTestMethods(snapshots, indexes, [test])).toEqual([second]);
    expect(
      testMatchesMethod({ ...test, evidence: [{ ...first.evidence, side: 'base' }] }, first),
    ).toBe(false);
  });
});
