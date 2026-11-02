import { describe, expect, it } from 'vitest';
import { indexedCallChain } from '../shared/sequence-calls';
import { sequenceView } from '../shared/sequence-view';
import { transactionRegions } from '../shared/transactions';
import {
  emptyModelResult,
  type Evidence,
  type IndexedMethod,
  type SourceIndex,
} from '../shared/model';
import type { SequenceScenario } from '../shared/sequence';

const ref = (path: string, startLine: number, endLine = startLine): Evidence => ({
  repoId: 'repo',
  side: 'head',
  path,
  startLine,
  endLine,
});
function fixture() {
  const invocation = ref('UploadService.kt', 58, 72);
  const queryCall = ref('RegistrationService.kt', 105);
  const query: IndexedMethod = {
    name: 'find',
    signature: 'fun find(id: String): String',
    annotations: [],
    calls: ['dsl.select'],
    evidence: ref('InvoiceRepository.kt', 200, 220),
    callSites: [
      {
        name: 'select',
        receiver: 'dsl',
        evidence: ref('InvoiceRepository.kt', 205),
        database: true,
        transactionIds: [],
      },
    ],
  };
  const registration: IndexedMethod = {
    name: 'register',
    signature: 'fun register(request: Registration): String',
    annotations: ['@Transactional'],
    calls: ['invoiceRepository.find'],
    evidence: ref('RegistrationService.kt', 100, 150),
    callSites: [
      {
        name: 'find',
        receiver: 'invoiceRepository',
        evidence: queryCall,
        database: false,
        transactionIds: ['inner'],
      },
    ],
  };
  const upload: IndexedMethod = {
    name: 'upload',
    signature: 'fun upload()',
    annotations: [],
    calls: ['registrationService.register'],
    evidence: ref('UploadService.kt', 20, 80),
    callSites: [
      {
        name: 'register',
        receiver: 'registrationService',
        evidence: invocation,
        database: false,
        transactionIds: [],
      },
    ],
  };
  const index: SourceIndex = {
    repoId: 'repo',
    side: 'head',
    methods: [upload, registration, query],
    errors: [],
    filesIndexed: 3,
  };
  const scenario: SequenceScenario = {
    id: 'upload',
    title: 'Загрузка',
    summary: '',
    services: ['repo', 'database:repo'],
    confidence: 'inferred',
    evidence: [upload.evidence],
    transactionScopes: { sql: ['inner'] },
    steps: [
      {
        id: 'sql',
        from: 'repo',
        to: 'database:repo',
        kind: 'database',
        label: 'SELECT id',
        branch: '',
        confidence: 'inferred',
        change: 'added',
        evidence: [invocation, queryCall, query.evidence],
      },
    ],
  };
  return { scenario, index, upload, registration, query, invocation };
}

describe('missing local calls before a database operation', () => {
  it('restores the intermediate service call before the repository and includes the method entry in TX', () => {
    const { scenario, index, invocation } = fixture();
    const original = JSON.stringify(scenario);
    const view = sequenceView(scenario, [index]);
    const name = (id: string) =>
      view.participants.find((participant) => participant.id === id)?.label;
    expect(view.scenario.steps.map((step) => [name(step.from), name(step.to)])).toEqual([
      ['UploadService', 'RegistrationService'],
      ['RegistrationService', 'InvoiceRepository'],
      ['InvoiceRepository', 'database:repo'],
    ]);
    const bridge = view.scenario.steps[0];
    expect(bridge.evidence[0]).toEqual(invocation);
    expect(view.scenario.transactionScopes?.[bridge.id]).toEqual([]);
    expect(
      transactionRegions(view.scenario, { ...emptyModelResult(), indexes: [index] })[0].start,
    ).toBe(0);
    expect(
      sequenceView(scenario, [index], new Set(['repo'])).scenario.steps.map((step) => step.id),
    ).toEqual(['sql']);
    expect(JSON.stringify(scenario)).toBe(original);
  });

  it('does not repeat an intermediate invocation for every SQL step or an existing explicit call', () => {
    const { scenario, index, invocation, registration } = fixture();
    scenario.steps.push({ ...scenario.steps[0], id: 'sql2' });
    const bridges = (value: SequenceScenario) =>
      sequenceView(value, [index]).scenario.steps.filter(
        (step) => step.label === 'UploadService → RegistrationService.register',
      );
    expect(bridges(scenario)).toHaveLength(1);
    scenario.steps.unshift({
      ...scenario.steps[0],
      id: 'explicit',
      kind: 'call',
      to: 'repo',
      label: 'UploadService → RegistrationService.register',
      evidence: [invocation, registration.evidence],
    });
    expect(bridges(scenario).map((step) => step.id)).toEqual(['explicit']);
  });

  it('does not choose between two possible invocation sites', () => {
    const { scenario, index, upload, query } = fixture();
    upload.callSites!.push({ ...upload.callSites![0], evidence: ref('UploadService.kt', 70) });
    expect(indexedCallChain(scenario.steps[0].evidence, query, [index])).toEqual([]);
    expect(
      sequenceView(scenario, [index]).scenario.steps.some((step) => step.id.startsWith('chain:')),
    ).toBe(false);
  });

  it('does not supply a missing edge from another side or an uncited call site', () => {
    const { scenario, index, upload, registration, query } = fixture();
    const refs = [ref('UploadService.kt', 20, 45), ...scenario.steps[0].evidence.slice(1)];
    expect(indexedCallChain(refs, query, [index]).map((edge) => edge.caller.name)).toEqual([
      'register',
    ]);
    index.methods = [upload, query];
    const base: SourceIndex = {
      ...index,
      side: 'base',
      methods: [{ ...registration, evidence: { ...registration.evidence, side: 'base' } }],
    };
    expect(indexedCallChain(scenario.steps[0].evidence, query, [index, base])).toEqual([]);
  });
});
