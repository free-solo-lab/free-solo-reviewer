import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Evidence, IndexedMethod, Scenario } from '../shared/model';
import { emptyModelResult } from '../shared/model';
import { transactionRegions, sequenceLayout } from '../shared/transactions';
import { databaseParticipant, withDatabaseInteractions } from '../shared/sequence';
const evidence = (
  path: string,
  startLine = 10,
  endLine = 30,
  repoId = 'orders',
  side: 'head' | 'base' = 'head',
): Evidence => ({ path, startLine, endLine, repoId, side });
const method = (
  name: string,
  path: string,
  annotations: string[],
  calls: string[] = [],
  startLine = 10,
  endLine = 30,
): IndexedMethod => ({
  name,
  signature: name,
  annotations,
  calls,
  evidence: evidence(path, startLine, endLine),
});
const data = (methods: IndexedMethod[]): AnalysisResult => ({
  ...emptyModelResult(),
  contracts: [],
  indexes: [{ repoId: 'orders', side: 'head', methods, errors: [], filesIndexed: methods.length }],
});
const scenario = (refs: Evidence[]): Scenario => ({
  id: 's',
  title: 'Order',
  summary: '',
  confidence: 'inferred',
  evidence: refs,
  services: ['orders', databaseParticipant('orders')],
  steps: refs.map((e, i) => ({
    id: String(i),
    from: 'orders',
    to: i === 0 ? 'orders' : databaseParticipant('orders'),
    label: 'step',
    kind: i === 0 ? 'call' : 'database',
    change: 'added',
    branch: '',
    confidence: 'inferred',
    evidence: [e],
  })),
});
describe('transaction scopes on sequence diagrams', () => {
  it('wraps annotated scope and its database calls, not handler or response', () => {
    const tx = method('register', 'service/Registration.kt', ['@Transactional']),
      outside = evidence('handler/Handler.kt');
    const s = scenario([outside, tx.evidence, tx.evidence, tx.evidence, outside]);
    const r = transactionRegions(s, data([tx]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ start: 1, end: 3, propagation: 'REQUIRED', mode: 'transaction' });
    expect(r[0].description).toContain('только при её отсутствии');
  });
  it('uses saved rollback/unknowns and does not mutate analysis', () => {
    const tx = method('run', 'service/Service.java', [
        '@Transactional(rollbackFor = IOException.class)',
      ]),
      result = data([tx]);
    result.transactions = [
      {
        id: 'tx',
        title: 'Tx',
        summary: '',
        evidence: [tx.evidence],
        confidence: 'inferred',
        propagation: 'REQUIRED',
        rollback: 'IOException triggers rollback',
        operations: [],
        unknowns: ['Manager unknown'],
      },
    ];
    const before = JSON.stringify(result),
      r = transactionRegions(scenario([tx.evidence]), result)[0];
    expect(r.rollback).toBe('IOException triggers rollback');
    expect(r.unknowns).toContain('Manager unknown');
    expect(JSON.stringify(result)).toBe(before);
  });
  it.each([
    ['REQUIRES_NEW', 'transaction'],
    ['NESTED', 'transaction'],
    ['SUPPORTS', 'conditional'],
    ['MANDATORY', 'conditional'],
    ['NOT_SUPPORTED', 'non-transactional'],
    ['NEVER', 'non-transactional'],
  ] as const)('shows propagation %s with the correct semantics', (propagation, mode) => {
    const tx = method('run', 'service/Service.kt', [
      `@Transactional(propagation = Propagation.${propagation})`,
    ]);
    expect(transactionRegions(scenario([tx.evidence]), data([tx]))[0]).toMatchObject({
      propagation,
      mode,
    });
  });
  it('marks self-invocation as uncertain instead of claiming a new transaction', () => {
    const tx = method('run', 'service/Service.kt', [
      '@Transactional(propagation = Propagation.REQUIRES_NEW)',
    ]);
    const caller = method('outer', 'service/Service.kt', [], ['this.run'], 40, 50);
    const region = transactionRegions(
      scenario([caller.evidence, tx.evidence]),
      data([caller, tx]),
    )[0];
    expect(region.mode).toBe('uncertain');
    expect(region.unknowns.join()).toContain('self-invocation');
  });
  it('does not assume that model transaction prose proves an annotation or span', () => {
    const plain = method('upload', 'service/Upload.kt', [], ['storage.upload']);
    const result = data([plain]);
    result.transactions = [
      {
        id: 't',
        title: 'Upload and registration are not atomic',
        summary: 'No transaction',
        propagation: 'REQUIRED',
        rollback: 'unknown',
        confidence: 'inferred',
        evidence: [plain.evidence],
        operations: [],
        unknowns: [],
      },
    ];
    expect(transactionRegions(scenario([plain.evidence]), result)).toHaveLength(0);
  });
  it('does not bridge an unrelated operation or match another side/repository', () => {
    const tx = method('run', 'service/Service.kt', ['@Transactional']),
      other = evidence('other/Other.kt');
    const r = transactionRegions(
      scenario([
        tx.evidence,
        other,
        tx.evidence,
        evidence('service/Service.kt', 10, 30, 'other'),
        evidence('service/Service.kt', 10, 30, 'orders', 'base'),
      ]),
      data([tx]),
    );
    expect(r.map((r) => [r.start, r.end])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });
  it('keeps outer transaction evidence through helper calls to the DB', () => {
    const tx = method('run', 'service/OrderService.kt', ['@Transactional'], ['helper.persist']);
    const helper = method('persist', 'service/Helper.kt', [], ['orderRepository.insert']);
    const repo = method('insert', 'repository/OrderRepository.kt', [], ['dsl.insertInto']);
    const result = data([tx, helper, repo]),
      s = scenario([tx.evidence]);
    s.services = ['orders'];
    const enriched = withDatabaseInteractions(s, result);
    const db = enriched.steps.find((s) => s.kind === 'database')!;
    expect(db.evidence).toContainEqual(tx.evidence);
    expect(transactionRegions(enriched, result)[0]).toMatchObject({ start: 0, end: 1 });
  });
  it('keeps a continuous transaction through a repository-only reference and excludes unrelated lifelines', () => {
    const tx = method(
      'register',
      'RegistrationService.kt',
      ['@Transactional'],
      ['invoiceRepository.find', 'accountRepository.insert'],
    );
    const repo = method('find', 'InvoiceRepository.kt', []);
    const account = method('insert', 'AccountRepository.kt', []);
    const s = scenario([
      evidence('Handler.kt'),
      tx.evidence,
      repo.evidence,
      account.evidence,
      tx.evidence,
      evidence('Handler.kt'),
    ]);
    const classId = (path: string) => `class:orders:${encodeURIComponent(path)}`;
    s.steps[1].from = classId('Handler.kt');
    s.steps[1].to = classId('RegistrationService.kt');
    s.steps[1].kind = 'call';
    s.steps[1].label = 'RegistrationService.register';
    s.steps[2].from = classId('InvoiceRepository.kt');
    s.steps[3].from = classId('AccountRepository.kt');
    s.steps[4].from = classId('RegistrationService.kt');
    const regions = transactionRegions(s, data([tx, repo, account]));
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ start: 1, end: 4 });
    expect(regions[0].participants).not.toContain(classId('Handler.kt'));
    expect(regions[0].participants).toContain(classId('RegistrationService.kt'));
    expect(regions[0].participants).toContain(databaseParticipant('orders'));
    const frame = sequenceLayout(s, regions).frames[0];
    expect(frame.boundaryParticipants).toContain(classId('Handler.kt'));
    expect(frame.participants).not.toContain(classId('Handler.kt'));
    s.steps[1].from = 'external:client';
    expect(sequenceLayout(s, regions).frames[0].boundaryParticipants).not.toContain(
      'external:client',
    );
  });
  it('keeps the transaction open over the queries of a DAO implementation it calls', () => {
    const classId = (path: string) => `class:orders:${encodeURIComponent(path)}`;
    const resource = method('post', 'api/AdjustmentApiResource.java', [], ['service.adjust']);
    const adjust = method(
      'adjust',
      'service/TransferPairAdjustmentService.java',
      ['@Transactional'],
      ['c2cTransactionDao.getLastByPaymentId', 'c2cTransactionDao.getForUpdate'],
      10,
      40,
    );
    // Spring injects the interface; the query lives in its Impl.
    const declared = method('getLastByPaymentId', 'dao/C2CTransactionDao.java', [], [], 5, 5);
    const last = method(
      'getLastByPaymentId',
      'dao/C2CTransactionDaoImpl.java',
      [],
      ['getDslContext.selectFrom'],
      119,
      127,
    );
    const lock = method(
      'getForUpdate',
      'dao/C2CTransactionDaoImpl.java',
      [],
      ['getDslContext.selectFrom'],
      130,
      140,
    );
    const step = (
      from: string,
      to: string,
      kind: 'call' | 'database',
      refs: Evidence[],
      label: string,
    ): Scenario['steps'][number] => ({
      id: label,
      from,
      to,
      label,
      kind,
      change: 'added',
      branch: '',
      confidence: 'inferred',
      evidence: refs,
    });
    const api = classId('api/AdjustmentApiResource.java'),
      service = classId('service/TransferPairAdjustmentService.java'),
      dao = classId('dao/C2CTransactionDaoImpl.java'),
      db = databaseParticipant('orders');
    const s: Scenario = {
      ...scenario([]),
      services: [api, service, dao, db],
      steps: [
        step(api, service, 'call', [resource.evidence, adjust.evidence], 'Service.adjust'),
        step(service, dao, 'call', [evidence(adjust.evidence.path, 15, 15)], 'getLastByPaymentId'),
        step(dao, db, 'database', [last.evidence], 'SQL'),
        step(service, dao, 'call', [evidence(adjust.evidence.path, 20, 20)], 'getForUpdate'),
        step(dao, db, 'database', [lock.evidence], 'SQL'),
      ],
    };
    const regions = transactionRegions(s, data([resource, adjust, declared, last, lock]));
    expect(regions.map((r) => [r.start, r.end])).toEqual([[0, 4]]);
    expect(regions[0].participants).toEqual(expect.arrayContaining([service, dao, db]));
    expect(regions[0].participants).not.toContain(api);
  });
  it('reserves room for overlapping scope labels and closes frames before the next step', () => {
    const a = method('outer', 'service/Outer.kt', ['@Transactional']);
    const b = method('inner', 'service/Inner.kt', [
      '@Transactional(propagation = Propagation.REQUIRES_NEW)',
    ]);
    const s = scenario([a.evidence, b.evidence, evidence('handler/Handler.kt')]);
    s.steps[0].evidence.push(b.evidence);
    const regions = transactionRegions(s, data([a, b])),
      layout = sequenceLayout(s, regions);
    expect(new Set(layout.frames.map((f) => f.top)).size).toBe(2);
    expect(
      layout.frames.every(
        (f) => f.top < layout.rows[f.start] - 28 && f.bottom > layout.rows[f.end] + 40,
      ),
    ).toBe(true);
    expect(layout.frames.every((f) => f.bottom < layout.rows[2] - 28)).toBe(true);
    expect(layout.height).toBeGreaterThan(layout.frames.at(-1)!.bottom);
  });
});
