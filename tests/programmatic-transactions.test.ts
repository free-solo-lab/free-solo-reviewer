import { describe, it, expect } from 'vitest';
import { indexSource } from '../server/indexer';
import { emptyModelResult, type Scenario, type AnalysisResult } from '../shared/model';
import { withDatabaseInteractions } from '../shared/sequence';
import { transactionRegions } from '../shared/transactions';

async function analyze(source: string, path = 'Service.kt') {
  const index = await indexSource(source, 'orders', 'head', path);
  expect(index.errors).toEqual([]);
  const root = index.methods.find((m) => m.name === 'run')!;
  const result: AnalysisResult = { ...emptyModelResult(), contracts: [], indexes: [index] };
  const scenario: Scenario = {
    id: 's',
    title: 'Test',
    summary: '',
    confidence: 'inferred',
    evidence: [root.evidence],
    services: ['orders'],
    steps: [
      {
        id: 'call',
        from: 'orders',
        to: 'orders',
        label: 'run',
        kind: 'call',
        change: 'added',
        branch: '',
        confidence: 'inferred',
        evidence: [root.evidence],
      },
    ],
  };
  const enriched = withDatabaseInteractions(scenario, result);
  return { index, result, scenario: enriched, regions: transactionRegions(enriched, result) };
}
describe('programmatic jOOQ transaction scopes', () => {
  it('separates queries before/inside/after the callback, even on one line', async () => {
    const { scenario, regions } = await analyze(`import org.jooq.DSLContext
class Service(val dsl: DSLContext) {
 fun run() { dsl.selectOne().fetch(); dsl.transaction { cfg -> cfg.dsl().insertInto(T).execute() }; dsl.selectCount().fetch() }
}`);
    expect(scenario.steps.map((s) => s.label)).toEqual([
      'run',
      'SELECT · Service.run',
      'INSERT · Service.run',
      'SELECT · Service.run',
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      start: 2,
      end: 2,
      mode: 'transaction',
      propagation: 'jOOQ · transaction',
    });
    expect(regions[0].unknowns.join()).not.toContain('self-invocation');
  });
  it('follows a same-bean helper called inside the callback, not its outside call', async () => {
    const { scenario, regions } = await analyze(`import org.jooq.DSLContext
class Service(val dsl: DSLContext) {
 fun run() {
  persist(dsl)
  dsl.transactionResult { cfg -> persist(cfg.dsl()) }
  persist(dsl)
 }
 fun persist(ctx: DSLContext) { ctx.insertInto(T).execute() }
}`);
    expect(scenario.steps.filter((s) => s.kind === 'database')).toHaveLength(3);
    expect(regions).toHaveLength(1);
    expect(regions[0].propagation).toBe('jOOQ · transactionResult');
    expect(scenario.steps[regions[0].start].label).toBe('INSERT · Service.persist');
  });
  it.each([
    'transaction',
    'transactionResult',
    'transactionAsync',
    'transactionResultAsync',
    'transactionPublisher',
  ])('recognizes Java %s lambdas and derived DSL contexts', async (api) => {
    const { index, regions } = await analyze(
      `import org.jooq.DSLContext;
class Service {
 DSLContext ctx;
 void run() {
  ctx.${api}(conf -> { conf.dsl().insertInto(T).execute(); });
 }
}`,
      'Service.java',
    );
    expect(index.methods.find((m) => m.name === 'run')?.programmaticTransactions).toHaveLength(1);
    expect(regions).toHaveLength(1);
    expect(regions[0].unknowns.join().includes('подписка')).toBe(/Async|Publisher/.test(api));
  });
  it('supports explicitly typed Java callbacks and DSL.using(configuration)', async () => {
    const { regions } = await analyze(
      `import org.jooq.DSLContext;
class Service { DSLContext ctx; void run() {
 ctx.transaction((Configuration conf) -> { DSL.using(conf).insertInto(T).execute(); });
} }`,
      'Service.java',
    );
    expect(regions).toHaveLength(1);
  });
  it('keeps nested callbacks separate and shows provider-dependent nesting', async () => {
    const { regions } = await analyze(`import org.jooq.DSLContext
class Service(val dsl: DSLContext) {
 fun run() {
  dsl.transaction { cfg ->
   cfg.dsl().insertInto(T).execute()
   cfg.dsl().transaction { inner -> inner.dsl().update(T).execute() }
   cfg.dsl().deleteFrom(T).execute()
  }
 }
}`);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ start: 1, end: 3 });
    expect(regions[1]).toMatchObject({ start: 2, end: 2 });
    expect(regions[1].unknowns.join()).toContain('Вложенный');
  });
  it('ignores unrelated APIs, comments and string literals', async () => {
    const { index, regions } = await analyze(`import org.jooq.DSLContext
class Service(val dsl: DSLContext, val business: Business) {
 fun run() {
  val text = "dsl.transaction { cfg -> cfg.dsl().insertInto(T) }"
  // dsl.transaction { cfg -> cfg.dsl().insertInto(T) }
  business.transaction { business.work() }
 }
}`);
    expect(index.methods[0].programmaticTransactions).toEqual([]);
    expect(regions).toEqual([]);
  });
  it('records a method reference without inventing an inline callback boundary', async () => {
    const { index, regions } = await analyze(
      `import org.jooq.DSLContext;
class Service { DSLContext ctx; void run() { ctx.transaction(this::persist); } void persist(Object conf) {} }`,
      'Service.java',
    );
    expect(
      index.methods.find((m) => m.name === 'run')?.programmaticTransactions?.[0].callback,
    ).toBe(false);
    expect(regions).toHaveLength(0);
  });
});
