import { describe, it, expect } from 'vitest';
import { sequenceMethod } from '../shared/sequence-method';
import { sequenceView } from '../shared/sequence-view';
import { databaseParticipant } from '../shared/sequence';
import type { Evidence, Scenario, Snapshot, SourceIndex } from '../shared/model';
const evidence: Evidence = {
  repoId: 'r',
  side: 'head',
  path: 'RegistrationService.kt',
  startLine: 10,
  endLine: 30,
};
const step: Scenario['steps'][number] = {
  id: 's',
  from: 'r',
  to: 'r',
  label: 'Handler → RegistrationService.register',
  kind: 'call',
  change: 'added',
  confidence: 'inferred',
  branch: 'Внутренний вызов восстановлен по ссылкам на код',
  evidence: [evidence],
};
const index: SourceIndex = {
  repoId: 'r',
  side: 'head',
  errors: [],
  filesIndexed: 1,
  methods: [
    {
      name: 'register',
      signature: 'fun register(request: Registration, options: Map<String, String>): Receipt',
      annotations: [],
      calls: [],
      evidence,
    },
  ],
};
const snapshot = {
  repoId: 'r',
  headFiles: ['dto/Registration.kt', 'dto/Receipt.kt'],
  baseFiles: ['old/Registration.kt'],
} as Snapshot;
describe('sequence method and model links', () => {
  it('resolves SELECT across an adjacent INSERT boundary and keeps its repository lifeline', () => {
    const repo = {
      ...evidence,
      path: 'repository/AccountRepository.kt',
      startLine: 20,
      endLine: 51,
    };
    const select = { ...repo, startLine: 53, endLine: 57 };
    const methods: SourceIndex = {
      ...index,
      methods: [
        {
          ...index.methods[0],
          name: 'upsert',
          evidence: repo,
          calls: ['dsl.insertInto'],
          callSites: [
            {
              name: 'insertInto',
              receiver: 'dsl',
              database: true,
              transactionIds: [],
              evidence: { ...repo, startLine: 21, endLine: 21 },
            },
          ],
        },
        {
          ...index.methods[0],
          name: 'findId',
          evidence: select,
          calls: ['dsl.select'],
          callSites: [
            {
              name: 'select',
              receiver: 'dsl',
              database: true,
              transactionIds: [],
              evidence: { ...select, endLine: 54 },
            },
          ],
        },
      ],
    };
    const dbStep = {
      ...step,
      kind: 'database' as const,
      label: 'SELECT существующего аккаунта',
      to: databaseParticipant('r'),
      evidence: [
        { ...repo, startLine: 49, endLine: 57 },
        { ...repo, path: 'repository/utils/AccountCondition.kt', startLine: 9, endLine: 19 },
      ],
    };
    expect(sequenceMethod(dbStep, [methods], []).evidence).toEqual(select);
    const view = sequenceView(
      {
        id: 'scenario',
        title: '',
        summary: '',
        confidence: 'inferred',
        evidence: dbStep.evidence,
        services: ['r', databaseParticipant('r')],
        steps: [dbStep],
      },
      [methods],
    );
    expect(view.scenario.steps).toHaveLength(1);
    expect(view.participants.find((p) => p.id === view.scenario.steps[0].from)?.label).toBe(
      'AccountRepository',
    );
    const insert = { ...dbStep, label: 'INSERT аккаунта', evidence: [repo] };
    expect(sequenceMethod(insert, [methods], []).evidence).toEqual(repo);
    const wrong = { ...dbStep, evidence: [repo] };
    expect(sequenceMethod(wrong, [methods], []).evidence).toBeUndefined();
  });
  it('finds the query of a DAO Impl that reaches jOOQ through getDslContext()', () => {
    const service = { ...evidence, path: 'service/TransferPairAdjustmentService.java' };
    const impl = {
      ...evidence,
      path: 'dao/C2CTransactionDaoImpl.java',
      startLine: 119,
      endLine: 127,
    };
    const methods: SourceIndex = {
      ...index,
      methods: [
        { ...index.methods[0], name: 'adjust', evidence: service, calls: [] },
        {
          ...index.methods[0],
          name: 'getLastByPaymentId',
          signature: 'public C2cTransaction getLastByPaymentId(String paymentId)',
          evidence: impl,
          calls: ['getDslContext().selectFrom'],
          callSites: [
            {
              name: 'selectFrom',
              receiver: 'getDslContext()',
              database: false,
              transactionIds: [],
              evidence: { ...impl, startLine: 121, endLine: 125 },
            },
          ],
        },
      ],
    };
    const dbStep = {
      ...step,
      kind: 'database' as const,
      label: 'Выбирает транзакцию с максимальным идентификатором под блокировкой',
      to: databaseParticipant('r'),
      evidence: [impl, { ...service, startLine: 15, endLine: 15 }],
    };
    expect(sequenceMethod(dbStep, [methods], []).evidence).toEqual(impl);
  });
  it('shows only the method and links Kotlin input/output models in the pinned snapshot', () => {
    const result = sequenceMethod(step, [index], [snapshot]);
    expect(result.label).toBe('register()');
    expect(result.inputs).toEqual([
      {
        name: 'Registration',
        evidence: { ...evidence, path: 'dto/Registration.kt', startLine: 1, endLine: 1 },
      },
      { name: 'Map<String, String>' },
    ]);
    expect(result.outputs[0]).toMatchObject({
      name: 'Receipt',
      evidence: { path: 'dto/Receipt.kt' },
    });
    expect(result.evidence).toEqual(evidence);
  });
  it('resolves Java signatures without linking ambiguous or external models', () => {
    const javaEvidence = { ...evidence, path: 'RegistrationService.java' };
    const javaIndex = {
      ...index,
      methods: [
        {
          ...index.methods[0],
          evidence: javaEvidence,
          signature: 'public Receipt register(final Registration request, String id)',
        },
      ],
    };
    const result = sequenceMethod(
      { ...step, evidence: [javaEvidence] },
      [javaIndex],
      [
        {
          ...snapshot,
          headFiles: ['one/Registration.java', 'two/Registration.java', 'dto/Receipt.java'],
        },
      ],
    );
    expect(result.inputs).toEqual([{ name: 'Registration' }, { name: 'String' }]);
    expect(result.outputs[0]).toMatchObject({
      name: 'Receipt',
      evidence: { path: 'dto/Receipt.java' },
    });
  });
  it('never links models from the wrong code side or repository', () => {
    const result = sequenceMethod(
      { ...step, evidence: [{ ...evidence, side: 'base' }] },
      [index],
      [snapshot],
    );
    expect(result.evidence).toBeUndefined();
    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
  });
});
