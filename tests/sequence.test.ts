import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Evidence, IndexedMethod, Scenario } from '../shared/model';
import { emptyModelResult } from '../shared/model';
import { databaseParticipant, withDatabaseInteractions } from '../shared/sequence';
import { serviceGroups } from '../shared/graph';
const ref = (
  path: string,
  startLine = 1,
  endLine = 10,
  repoId = 'orders',
  side: 'head' | 'base' = 'head',
): Evidence => ({ repoId, side, path, startLine, endLine });
const method = (
  name: string,
  path: string,
  calls: string[],
  repoId = 'orders',
  side: 'head' | 'base' = 'head',
): IndexedMethod => ({
  name,
  signature: name,
  annotations: [],
  calls,
  evidence: ref(path, 1, 10, repoId, side),
});
const scenario = (refs: Evidence[], steps = true): Scenario => ({
  id: 's',
  title: 'Order',
  summary: 'Scenario',
  confidence: 'inferred',
  evidence: refs,
  services: ['orders'],
  steps: steps
    ? [
        {
          id: 'step',
          from: 'orders',
          to: 'orders',
          label: 'Register order',
          kind: 'call',
          change: 'added',
          branch: 'valid request',
          confidence: 'inferred',
          evidence: refs,
        },
        {
          id: 'return',
          from: 'orders',
          to: 'orders',
          label: 'Return',
          kind: 'return',
          change: 'added',
          branch: '',
          confidence: 'inferred',
          evidence: refs,
        },
      ]
    : [],
});
const analysis = (methods: IndexedMethod[]): AnalysisResult => ({
  ...emptyModelResult(),
  contracts: [],
  indexes: [{ repoId: 'orders', side: 'head', methods, errors: [], filesIndexed: methods.length }],
});
const fixtures = () => {
  const service = method('register', 'service/OrderService.kt', [
    'orderRepository.find',
    'orderRepository.insert',
  ]);
  const read = method('find', 'repository/OrderRepository.kt', ['dsl.select', 'from', 'fetchOne']);
  read.evidence = ref('repository/OrderRepository.kt', 12, 20);
  const write = method('insert', 'repository/OrderRepository.kt', [
    'dsl.insertInto',
    'JSONB.valueOf',
    'execute',
  ]);
  write.evidence = ref('repository/OrderRepository.kt', 22, 30);
  return { service, read, write };
};
describe('database interactions in saved sequence diagrams', () => {
  it('traces service → repository SQL, adds a DB lifeline and preserves original data', () => {
    const { service, read, write } = fixtures(),
      s = scenario([service.evidence]),
      result = analysis([service, read, write]),
      before = JSON.stringify({ s, result });
    const enriched = withDatabaseInteractions(s, result);
    const db = enriched.steps.filter((s) => s.kind === 'database');
    expect(db.map((s) => s.label)).toEqual([
      'SELECT · OrderRepository.find',
      'INSERT · OrderRepository.insert',
    ]);
    expect(
      db.every((s) => s.to === databaseParticipant('orders') && s.confidence === 'inferred'),
    ).toBe(true);
    expect(db[0].evidence).toContainEqual(read.evidence);
    expect(enriched.steps.at(-1)?.kind).toBe('return');
    expect(serviceGroups(enriched).flat()).toEqual(['orders', databaseParticipant('orders')]);
    expect(JSON.stringify({ s, result })).toBe(before);
  });
  it('prefers the closest matching step rather than duplicating nested calls', () => {
    const { service, read, write } = fixtures(),
      outer = method('handle', 'service/Handler.kt', ['orderService.register']);
    const s = scenario([outer.evidence]);
    s.steps.splice(1, 0, { ...s.steps[0], id: 'inner', evidence: [service.evidence] });
    const enriched = withDatabaseInteractions(s, analysis([outer, service, read, write]));
    expect(enriched.steps.map((s) => s.kind)).toEqual([
      'call',
      'call',
      'database',
      'database',
      'return',
    ]);
  });
  it('supports background scenarios without model steps', () => {
    const { service, read, write } = fixtures();
    expect(
      withDatabaseInteractions(
        scenario([service.evidence], false),
        analysis([service, read, write]),
      ).steps,
    ).toHaveLength(2);
  });
  it('uses transaction DB evidence in older analyses without indexes, excluding migrations', () => {
    const s = scenario([ref('service/OrderService.kt')]),
      result = analysis([]);
    result.transactions = [
      {
        id: 'tx',
        title: 'Register',
        summary: 'Tx',
        confidence: 'inferred',
        evidence: s.evidence,
        propagation: 'REQUIRED',
        rollback: 'unknown',
        unknowns: [],
        operations: [{ label: 'Save order', kind: 'database', risk: '', evidence: s.evidence }],
      },
    ];
    result.database = [
      {
        id: 'ddl',
        title: 'CREATE TABLE',
        summary: 'Migration',
        kind: 'migration',
        dialect: 'SQL',
        sql: 'CREATE TABLE orders(id int)',
        tables: ['orders'],
        unknowns: [],
        confidence: 'extracted',
        evidence: s.evidence,
      },
    ];
    const db = withDatabaseInteractions(s, result).steps.filter((s) => s.kind === 'database');
    expect(db).toHaveLength(1);
    expect(db[0].label).toBe('Save order');
  });
  it('does not guess unrelated, ambiguous or opposite-side repository methods', () => {
    const service = method('run', 'service/OrderService.kt', ['x.read']),
      a = method('read', 'repository/A.kt', ['dsl.select']),
      b = method('read', 'repository/B.kt', ['dsl.select']);
    const base = method('read', 'repository/X.kt', ['dsl.select'], 'orders', 'base');
    expect(
      withDatabaseInteractions(
        scenario([service.evidence]),
        analysis([service, a, b, base]),
      ).steps.filter((s) => s.kind === 'database'),
    ).toHaveLength(0);
  });
  it('recognises unresolved ORM calls without claiming native SQL or table names', () => {
    const s = method('run', 'service/OrderService.java', ['repository.save']);
    const db = withDatabaseInteractions(scenario([s.evidence]), analysis([s])).steps.find(
      (s) => s.kind === 'database',
    );
    expect(db?.label).toBe('repository.save');
    expect(db?.evidence).toEqual([s.evidence]);
  });
  it('does not duplicate explicit model database steps', () => {
    const { service, read, write } = fixtures(),
      s = scenario([service.evidence]);
    s.steps = [
      { ...s.steps[0], kind: 'database', evidence: [service.evidence], label: 'Save order' },
    ];
    const enriched = withDatabaseInteractions(s, analysis([service, read, write]));
    expect(enriched.steps).toHaveLength(1);
    expect(enriched.steps[0].to).toBe(databaseParticipant('orders'));
  });
  it('handles recursion without hanging or creating bogus object-prototype SQL verbs', () => {
    const a = method('run', 'service/OrderService.kt', ['this.run', 'valueOf', 'toString']);
    expect(
      withDatabaseInteractions(scenario([a.evidence]), analysis([a])).steps.filter(
        (s) => s.kind === 'database',
      ),
    ).toHaveLength(0);
  });
});
