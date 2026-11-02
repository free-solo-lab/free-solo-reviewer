import { describe, expect, it } from 'vitest';
import { missingSqlMethods, queryMatchesMethod } from '../shared/sql-coverage';
import type { Snapshot, SourceIndex, IndexedMethod, DatabaseOperation } from '../shared/model';

const method = (
  path = 'src/main/Repository.kt',
  side: 'base' | 'head' = 'head',
): IndexedMethod => ({
  name: 'find',
  signature: 'fun find()',
  annotations: [],
  calls: ['dsl.select'],
  evidence: { repoId: 'repo', side, path, startLine: 10, endLine: 20 },
  callSites: [
    {
      name: 'select',
      receiver: 'dsl',
      evidence: { repoId: 'repo', side, path, startLine: 12, endLine: 12 },
      transactionIds: [],
      database: true,
    },
  ],
});
const operation = (m: IndexedMethod): DatabaseOperation => ({
  id: 'query',
  title: 'Select',
  summary: '',
  confidence: 'inferred',
  evidence: [m.evidence],
  kind: 'jooq',
  sql: '',
  dialect: 'unknown',
  tables: [],
  unknowns: ['Missing generated mapping'],
  query: { method: 'Repository.find', framework: 'jooq', evidence: m.evidence, parameters: [] },
});
describe('SQL method coverage', () => {
  it('ignores tests and old versions; accepts an explicit unknown only for its exact method', () => {
    const current = method(),
      old = method(undefined, 'base'),
      test = method('src/test/RepositoryTest.kt');
    const snapshot = {
      repoId: 'repo',
      headFiles: [current.evidence.path, test.evidence.path],
    } as Snapshot;
    const indexes = [{ methods: [current, old, test] }] as SourceIndex[];
    expect(missingSqlMethods([snapshot], indexes, [operation(old)])).toEqual([current]);
    expect(missingSqlMethods([snapshot], indexes, [operation(current)])).toEqual([]);
    const wrong = operation(current);
    wrong.query!.evidence = { ...current.evidence, startLine: 9 };
    expect(queryMatchesMethod(wrong, current)).toBe(false);
    wrong.query!.evidence = current.evidence;
    wrong.query!.method = 'Repository.insert';
    expect(queryMatchesMethod(wrong, current)).toBe(false);
  });
});
