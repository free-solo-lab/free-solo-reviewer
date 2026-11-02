import { describe, expect, it } from 'vitest';
import {
  affectedProductionMethods,
  directlyChanged,
  reviewScopeSnapshots,
} from '../shared/analysis-scope';
import { reviewTestMethods } from '../shared/test-coverage';
import { scenarioRoots } from '../shared/scenario-coverage';
import { sqlMethods } from '../shared/sql-coverage';
import type { IndexedMethod, Snapshot, SourceIndex, ReviewSession } from '../shared/model';
const method = (path: string, name: string, calls: string[] = [], test = false): IndexedMethod => ({
  name,
  calls,
  signature: `fun ${name}()`,
  annotations: test ? ['@Test'] : [],
  evidence: { repoId: 'r', side: 'head', path, startLine: 10, endLine: 20 },
});
function input(methods: IndexedMethod[], changed: string) {
  return {
    snapshots: [
      {
        repoId: 'r',
        headFiles: methods.map((m) => m.evidence.path),
        files: [{ path: changed, status: 'M', patch: '', addedLines: [12], removedLines: [12] }],
      },
    ] as unknown as Snapshot[],
    indexes: [{ methods }] as SourceIndex[],
  };
}
describe('change-focused analysis scope', () => {
  it('never schedules project-wide tests or queries for documentation-only changes', () => {
    const tests = Array.from({ length: 516 }, (_, i) =>
      method(`src/test/Test${i}.kt`, 'works', [], true),
    );
    const { snapshots, indexes } = input(
      [...tests, method('src/main/Repository.kt', 'select')],
      'docs/readme.md',
    );
    expect(reviewTestMethods(snapshots, indexes)).toEqual([]);
    expect(sqlMethods(snapshots, indexes)).toEqual([]);
  });
  it('keeps only callers leading to the changed code, without expanding outgoing queries or unchanged tests', () => {
    const repo = method('src/main/Repository.kt', 'find');
    repo.callSites = [
      {
        name: 'select',
        receiver: 'dsl',
        evidence: repo.evidence,
        transactionIds: [],
        database: true,
      },
    ];
    const changed = method('src/main/Converter.kt', 'convert', ['repository.find']);
    const service = method('src/main/Service.kt', 'run', ['converter.convert']);
    const related = method('src/test/ServiceTest.kt', 'works', ['service.run'], true);
    const unrelated = method('src/test/OtherTest.kt', 'other', [], true);
    const { snapshots, indexes } = input(
      [repo, changed, service, related, unrelated],
      changed.evidence.path,
    );
    expect(affectedProductionMethods(snapshots, indexes)).toEqual([changed, service]);
    expect(reviewTestMethods(snapshots, indexes)).toEqual([]);
    expect(sqlMethods(snapshots, indexes)).toEqual([]);
  });
  it('reaches callers at any depth in any index order and leaves ambiguous calls unresolved', () => {
    const changed = method('src/main/Converter.kt', 'convert');
    const middle = method('src/main/Mapper.kt', 'map', ['CONVERTER.convert']);
    const top = method('src/main/Handler.kt', 'handle', ['mapper.map']);
    const job = method('src/main/Job.kt', 'run', ['save']);
    const { snapshots, indexes } = input(
      [top, middle, job, method('src/main/A.kt', 'save'), method('src/main/B.kt', 'save'), changed],
      changed.evidence.path,
    );
    expect(affectedProductionMethods(snapshots, indexes)).toEqual([top, middle, changed]);
  });
  it('never makes unchanged tests targets because a fixture or setup changed', () => {
    const helper = method('src/test/ReaderTest.kt', 'fixture');
    helper.annotations = [];
    const test = method(helper.evidence.path, 'reads', ['fixture'], true);
    test.evidence = { ...test.evidence, startLine: 30, endLine: 40 };
    const other = method('src/test/OtherTest.kt', 'other', [], true);
    const { snapshots, indexes } = input([helper, test, other], helper.evidence.path);
    expect(reviewTestMethods(snapshots, indexes)).toEqual([]);
    helper.annotations = ['@BeforeEach'];
    test.calls = [];
    expect(reviewTestMethods(snapshots, indexes)).toEqual([]);
  });
  it('selects one changed test method, not its whole class or consumers of a shared model', () => {
    const changed = method('src/test/SharedTest.kt', 'changed', [], true);
    const sameClass = method(changed.evidence.path, 'unchanged', [], true);
    sameClass.evidence = { ...sameClass.evidence, startLine: 30, endLine: 40 };
    const others = Array.from({ length: 300 }, (_, i) =>
      method(`src/test/Other${i}.kt`, 'works', ['service.run'], true),
    );
    const { snapshots, indexes } = input([changed, sameClass, ...others], changed.evidence.path);
    expect(reviewTestMethods(snapshots, indexes)).toEqual([changed]);
    snapshots[0].files = [
      {
        path: 'src/main/BaseModel.java',
        status: 'M',
        patch: '',
        addedLines: [3],
        removedLines: [3],
      },
    ];
    expect(reviewTestMethods(snapshots, indexes)).toEqual([]);
  });
  it('detects a deletion-only method change without selecting the next method', () => {
    const changed = method('src/test/ReaderTest.kt', 'changed', [], true);
    const adjacent = method(changed.evidence.path, 'adjacent', [], true);
    adjacent.evidence = { ...adjacent.evidence, startLine: 21, endLine: 30 };
    const { snapshots, indexes } = input([changed, adjacent], changed.evidence.path);
    snapshots[0].files[0] = {
      path: changed.evidence.path,
      status: 'M',
      addedLines: [],
      removedLines: [12],
      patch: '@@ -11,3 +11,2 @@\n keep\n-assertOld()\n keep',
    };
    expect(directlyChanged(changed, snapshots)).toBe(true);
    expect(reviewTestMethods(snapshots, indexes)).toEqual([changed]);
  });
  it('only requests SQL affected by changed predicates, not other queries called by the same service', () => {
    const predicate = method('src/main/Predicate.kt', 'where');
    const query = method('src/main/Repository.kt', 'find', [
      'predicate.where',
      'jdbcTemplate.query',
    ]);
    const other = method('src/main/OtherRepository.kt', 'count', ['jdbcTemplate.query']);
    const service = method('src/main/Service.kt', 'run', [
      'repository.find',
      'otherRepository.count',
    ]);
    const { snapshots, indexes } = input(
      [predicate, query, other, service],
      predicate.evidence.path,
    );
    expect(sqlMethods(snapshots, indexes)).toEqual([query]);
  });
  it('uses only the new delta on follow-up, not every original PR change', () => {
    const old = method('src/test/OldTest.kt', 'old', [], true),
      changed = method('src/test/NewTest.kt', 'new', [], true);
    const { snapshots, indexes } = input([old, changed], old.evidence.path);
    const file = { ...snapshots[0].files[0], path: changed.evidence.path };
    snapshots[0].files.push(file);
    const session = {
      snapshots,
      run: { previousReviewId: 'review' },
      update: {
        previousReviewId: 'review',
        changes: [{ repoId: 'r', fromSha: 'before', toSha: 'after', files: [file] }],
      },
    } as unknown as ReviewSession;
    expect(reviewTestMethods(reviewScopeSnapshots(session), indexes)).toEqual([changed]);
  });

  it('does not schedule every entry of a controller when only one method changed', () => {
    const changed = method('src/main/ReaderController.kt', 'read');
    const unchanged = method(changed.evidence.path, 'list');
    unchanged.evidence = { ...unchanged.evidence, startLine: 30, endLine: 40 };
    const { snapshots, indexes } = input([changed, unchanged], changed.evidence.path);
    snapshots[0].local = {} as Snapshot['local'];
    expect(scenarioRoots(snapshots, indexes).map((root) => root.name)).toEqual([
      'ReaderController.read',
    ]);
  });
});
