import { describe, it, expect } from 'vitest';
import { sequenceView, sequenceParticipantLayout } from '../shared/sequence-view';
import { transactionRegions } from '../shared/transactions';
import { emptyModelResult, type Evidence, type SourceIndex } from '../shared/model';
import { type SequenceScenario, databaseParticipant } from '../shared/sequence';
import { sequenceMethod } from '../shared/sequence-method';
const ref = (path: string, repoId = 'orders'): Evidence => ({
  repoId,
  side: 'head',
  path,
  startLine: 10,
  endLine: 20,
});
const handler = ref('Handler.kt'),
  service = ref('OrderService.kt'),
  repository = ref('OrderRepository.kt');
const index: SourceIndex = {
  repoId: 'orders',
  side: 'head',
  errors: [],
  filesIndexed: 3,
  methods: [
    {
      name: 'run',
      signature: 'run',
      annotations: ['@Transactional'],
      calls: [],
      evidence: service,
    },
    { name: 'insert', signature: 'insert', annotations: [], calls: [], evidence: repository },
  ],
};
const scenario = (): SequenceScenario => ({
  id: 's',
  title: 'Order',
  summary: '',
  confidence: 'inferred',
  evidence: [handler, service],
  services: ['orders', 'payments', databaseParticipant('orders')],
  transactionScopes: { db: ['manual'] },
  steps: [
    {
      id: 'internal',
      from: 'orders',
      to: 'orders',
      label: 'Handler → OrderService: register',
      kind: 'call',
      change: 'added',
      branch: '',
      confidence: 'inferred',
      evidence: [handler, service],
    },
    {
      id: 'db',
      from: 'orders',
      to: databaseParticipant('orders'),
      label: 'INSERT · OrderRepository.insert',
      kind: 'database',
      change: 'unknown',
      branch: '',
      confidence: 'inferred',
      evidence: [repository, service],
    },
    {
      id: 'external',
      from: 'orders',
      to: 'payments',
      label: 'OrderService → PaymentClient: pay',
      kind: 'call',
      change: 'added',
      branch: '',
      confidence: 'inferred',
      evidence: [service, ref('PaymentClient.kt', 'payments')],
    },
  ],
});
describe('class lifelines and service collapsing', () => {
  it.each(['→', '->'])(
    'keeps a service-to-client call when prose contains %s in a nested subflow',
    (arrow) => {
      const upload = { ...ref('ReceiptUploadService.kt'), startLine: 40, endLine: 78 };
      const client = { ...ref('ReceiptStorageClient.kt'), startLine: 36, endLine: 62 };
      const invocation = { ...upload, startLine: 53, endLine: 57 };
      const indexed: SourceIndex = {
        ...index,
        methods: [
          {
            name: 'uploadReceipt',
            signature: 'fun uploadReceipt(request: UploadRequest): Receipt',
            annotations: [],
            calls: ['receiptStorageClient.uploadFile'],
            evidence: upload,
            callSites: [
              {
                name: 'uploadFile',
                receiver: 'receiptStorageClient',
                evidence: invocation,
                database: false,
                transactionIds: [],
              },
            ],
          },
          {
            name: 'uploadFile',
            signature: 'fun uploadFile(content: ByteArray): String',
            annotations: [],
            calls: ['objectStore.putObject'],
            evidence: client,
          },
        ],
      };
      const s = scenario();
      s.services = ['orders'];
      s.evidence = [upload];
      s.steps = [
        {
          ...s.steps[0],
          label: `После проверок вызвать локальный ReceiptStorageClient.uploadFile: внутри putObject ${arrow} HTTP PUT`,
          evidence: [{ ...upload, endLine: 57 }, client],
        },
      ];
      const original = JSON.stringify(s);
      const view = sequenceView(s, [indexed]);
      const step = view.scenario.steps[0];
      expect(view.participants.find((item) => item.id === step.from)?.label).toBe(
        'ReceiptUploadService',
      );
      expect(view.participants.find((item) => item.id === step.to)?.label).toBe(
        'ReceiptStorageClient',
      );
      expect(view.participants.find((item) => item.id === step.to)?.evidence).toEqual({
        ...client,
        startLine: 1,
        endLine: 1,
      });
      expect(step.evidence[0]).toEqual(invocation);
      expect(step.label).toBe('ReceiptUploadService → ReceiptStorageClient.uploadFile');
      expect(view.scenario.steps).toHaveLength(1);
      expect(sequenceView(s, [indexed], new Set(['orders'])).scenario.steps).toHaveLength(0);
      expect(JSON.stringify(s)).toBe(original);
    },
  );

  it('connects a prose-labelled delegation to the indexed callee instead of a self-call', () => {
    const caller = ref('OrderRegistryService.kt');
    const callee = ref('OrderRegistrationService.kt');
    const call = { ...caller, startLine: 19, endLine: 19 };
    const delegation: SourceIndex = {
      ...index,
      methods: [
        {
          name: 'registerOrder',
          signature: 'fun registerOrder(request: RegisterOrderRequest): String ',
          evidence: caller,
          annotations: [],
          calls: ['orderRegistrationService.registerOrder'],
          callSites: [
            {
              name: 'registerOrder',
              receiver: 'orderRegistrationService',
              evidence: call,
              database: false,
              transactionIds: [],
            },
          ],
        },
        {
          name: 'registerOrder',
          signature: 'fun registerOrder(registration: OrderRegistration): String ',
          evidence: callee,
          annotations: ['@Transactional'],
          calls: [],
        },
      ],
    };
    const s = scenario();
    s.steps = [
      {
        ...s.steps[0],
        label: 'Валидация RegisterOrder и вызов отдельного bean OrderRegistrationService',
        evidence: [caller],
      },
    ];
    const before = JSON.stringify(s);
    const view = sequenceView(s, [delegation]);
    const step = view.scenario.steps[0];
    expect(view.participants.find((p) => p.id === step.from)?.label).toBe('OrderRegistryService');
    expect(view.participants.find((p) => p.id === step.to)?.label).toBe('OrderRegistrationService');
    expect(sequenceMethod(step, [delegation], []).inputs).toEqual([{ name: 'OrderRegistration' }]);
    const layout = sequenceParticipantLayout(view.participants);
    expect(layout.positions.get(step.from)!.x).toBeLessThan(layout.positions.get(step.to)!.x);
    expect(
      transactionRegions(view.scenario, { ...emptyModelResult(), indexes: [delegation] })[0].start,
    ).toBe(0);
    expect(sequenceView(s, [delegation], new Set(['orders'])).scenario.steps).toHaveLength(0);
    expect(JSON.stringify(s)).toBe(before);
    // A matching class name in the other version must not supply an endpoint.
    const otherSide: SourceIndex = {
      ...delegation,
      methods: [
        delegation.methods[0],
        { ...delegation.methods[1], evidence: { ...callee, side: 'base' } },
      ],
    };
    expect(sequenceView(s, [otherSide]).scenario.steps).toHaveLength(0);
  });
  it('separates same-service classes and links the repository to its caller and DB', () => {
    const source = scenario(),
      before = JSON.stringify(source);
    const view = sequenceView(source, [index]);
    const label = (id: string) => view.participants.find((p) => p.id === id)?.label;
    expect(view.scenario.steps.map((s) => [label(s.from), label(s.to)])).toEqual([
      ['Handler', 'OrderService'],
      ['OrderService', 'OrderRepository'],
      ['OrderRepository', databaseParticipant('orders')],
      ['OrderService', 'PaymentClient'],
    ]);
    expect(view.scenario.steps[1].confidence).toBe('inferred');
    expect(view.scenario.transactionScopes?.['internal:db']).toEqual(['manual']);
    expect(view.scenario.steps[2].evidence).toEqual([repository, service]);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('collapses only the selected service and keeps DB/external calls', () => {
    const view = sequenceView(scenario(), [index], new Set(['orders']));
    expect(view.scenario.steps.map((s) => s.id)).toEqual(['db', 'external']);
    expect(view.scenario.steps[0]).toMatchObject({
      from: 'orders',
      to: databaseParticipant('orders'),
    });
    expect(view.scenario.steps[1].from).toBe('orders');
    expect(view.participants.filter((p) => p.kind === 'class').map((p) => p.label)).toEqual([
      'PaymentClient',
    ]);
    expect(view.internalCount.get('orders')).toBe(2);
  });
  it('collapses all services without losing cross-service links or transaction evidence', () => {
    const view = sequenceView(scenario(), [index], new Set(['orders', 'payments']));
    expect(view.scenario.steps[1]).toMatchObject({ from: 'orders', to: 'payments' });
    const regions = transactionRegions(view.scenario, { ...emptyModelResult(), indexes: [index] });
    expect(regions[0]).toMatchObject({ start: 0, end: 1, propagation: 'REQUIRED' });
    expect(view.scenario.transactionScopes?.db).toEqual(['manual']);
    expect(view.participants.some((p) => p.kind === 'class')).toBe(false);
  });
  it('can expand back without mutating or duplicating source steps', () => {
    const source = scenario();
    sequenceView(source, [index], new Set(['orders']));
    const view = sequenceView(source, [index]);
    expect(view.scenario.steps).toHaveLength(4);
    expect(new Set(view.scenario.steps.map((s) => s.id)).size).toBe(4);
  });
  it('keeps ambiguous classes in separate repository namespaces', () => {
    const s = scenario();
    s.steps[2].evidence = [ref('OrderService.kt'), ref('OrderService.kt', 'payments')];
    s.steps[2].label = 'OrderService → OrderService: call';
    const view = sequenceView(s, [index]);
    const step = view.scenario.steps.at(-1)!;
    expect(step.from).not.toBe(step.to);
    expect(view.participants.find((p) => p.id === step.from)?.owner).toBe('orders');
    expect(view.participants.find((p) => p.id === step.to)?.owner).toBe('payments');
  });
  it('keeps an unused service header valid even when no steps reference it', () => {
    const s = scenario();
    s.services.push('context-only');
    const view = sequenceView(s, [index]);
    expect(view.participants.some((p) => p.id === 'context-only' && p.kind === 'service')).toBe(
      true,
    );
  });
  it('hides method internals instead of drawing a self-call or service-to-class call', () => {
    const s = scenario();
    s.steps = [{ ...s.steps[0], label: 'Проверка запроса', evidence: [service] }];
    const view = sequenceView(s, [index]);
    expect(view.scenario.steps).toHaveLength(0);
  });
  it('uses the query class rather than caller-first evidence ordering and avoids a duplicate bridge', () => {
    const s = scenario();
    s.steps[0] = {
      ...s.steps[0],
      label: 'OrderService → OrderRepository: insert',
      evidence: [service, repository],
    };
    s.steps[1].evidence = [service, repository];
    const view = sequenceView(s, [index]);
    expect(view.scenario.steps.filter((step) => step.id === 'internal:db')).toHaveLength(0);
    const db = view.scenario.steps.find((step) => step.id === 'db')!;
    expect(view.participants.find((p) => p.id === db.from)?.label).toBe('OrderRepository');
  });
  it('directs SQL-only steps from the caller to the repository regardless of evidence order', () => {
    for (const evidence of [
      [service, repository],
      [repository, service],
    ]) {
      const s = scenario();
      s.steps = [{ ...s.steps[1], label: 'SELECT id WHERE external_id = ?', evidence }];
      const view = sequenceView(s, [index]);
      const label = (id: string) => view.participants.find((p) => p.id === id)?.label;
      expect(view.scenario.steps.map((step) => [label(step.from), label(step.to)])).toEqual([
        ['OrderService', 'OrderRepository'],
        ['OrderRepository', databaseParticipant('orders')],
      ]);
      expect(view.scenario.steps[0].label).toBe('OrderService → OrderRepository.insert');
      const positions = sequenceParticipantLayout(view.participants).positions;
      const call = view.scenario.steps[0];
      expect(positions.get(call.from)!.x).toBeLessThan(positions.get(call.to)!.x);
    }
  });
  it('puts service and DB cards on the top row with classes underneath in both modes', () => {
    for (const collapsed of [new Set<string>(), new Set(['orders', 'payments'])]) {
      const view = sequenceView(scenario(), [index], collapsed);
      const layout = sequenceParticipantLayout(view.participants);
      for (const p of view.participants) {
        expect(layout.positions.get(p.id)?.y).toBe(p.kind === 'class' ? 94 : 12);
      }
      const root = layout.positions.get('orders')!;
      const children = view.participants.filter((p) => p.owner === 'orders' && p.kind === 'class');
      for (const child of children) {
        const point = layout.positions.get(child.id)!;
        expect(point.x).toBeGreaterThanOrEqual(root.x - root.width / 2);
        expect(point.x).toBeLessThanOrEqual(root.x + root.width / 2);
      }
      const leafColumns = view.participants.filter(
        (p) =>
          p.kind !== 'service' ||
          !view.participants.some((c) => c.owner === p.owner && c.kind === 'class'),
      );
      expect(new Set(leafColumns.map((p) => layout.positions.get(p.id)?.x)).size).toBe(
        leafColumns.length,
      );
    }
  });
  it('does not invent a class when no code reference resolves it', () => {
    const s = scenario();
    s.steps = [{ ...s.steps[0], label: 'unresolved call', evidence: [] }];
    const view = sequenceView(s, []);
    expect(view.scenario.steps).toHaveLength(0);
    expect(view.participants.some((p) => p.kind === 'class')).toBe(false);
  });
});
