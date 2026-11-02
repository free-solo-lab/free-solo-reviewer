import { describe, expect, it } from 'vitest';
import { sequenceView, sequenceParticipantLayout } from '../shared/sequence-view';
import { withExternalBoundary } from '../shared/sequence-boundary';
import { sequenceMethod } from '../shared/sequence-method';
import type { Evidence, IndexedMethod, SourceIndex } from '../shared/model';
import type { SequenceScenario } from '../shared/sequence';
const ref = (path: string): Evidence => ({
  repoId: 'r',
  side: 'head',
  path,
  startLine: 10,
  endLine: 20,
});
const controller = ref('RegistryHandler.kt'),
  service = ref('RegistryService.kt'),
  registration = ref('RegistrationService.kt');
const method = (evidence: Evidence, calls: string[] = []): IndexedMethod => ({
  name: 'register',
  signature: 'fun register(request: Request): Response',
  annotations: [],
  evidence,
  calls,
});
const index: SourceIndex = {
  repoId: 'r',
  side: 'head',
  filesIndexed: 3,
  errors: [],
  methods: [
    method(controller, ['registryService.register']),
    method(service, ['registrationService.register']),
    method(registration),
  ],
};
const scenario = (): SequenceScenario => ({
  id: 's',
  title: 'Register',
  summary: '',
  confidence: 'inferred',
  evidence: [service],
  services: ['r'],
  steps: [
    {
      id: 'entry',
      from: 'r',
      to: 'r',
      label: 'Валидация и вызов RegistrationService.register',
      kind: 'call',
      change: 'added',
      confidence: 'inferred',
      branch: '',
      evidence: [service],
    },
    {
      id: 'reply',
      from: 'r',
      to: 'r',
      label: 'Возврат Response обработчика',
      kind: 'return',
      change: 'added',
      confidence: 'inferred',
      branch: '',
      evidence: [controller],
    },
  ],
});
describe('external request and response boundaries', () => {
  it('preserves an explicit outgoing handler call when inserting the external entry', () => {
    const source = scenario();
    source.steps = [
      {
        ...source.steps[0],
        label: 'RegistryHandler.register -> RegistryService.register',
        evidence: [controller, service],
      },
    ];
    const view = sequenceView(source, [index]);
    const label = (id: string) =>
      view.participants.find((participant) => participant.id === id)?.label;
    expect(view.scenario.steps.map((step) => [label(step.from), label(step.to)])).toEqual([
      ['Внешний клиент', 'RegistryHandler'],
      ['RegistryHandler', 'RegistryService'],
    ]);
  });
  it('shows an external request to the indexed handler, internal calls, and a response to the same client', () => {
    const source = scenario(),
      original = JSON.stringify(source);
    const view = sequenceView(source, [index]);
    const label = (id: string) => view.participants.find((p) => p.id === id)?.label;
    expect(
      view.scenario.steps.map((step) => [step.kind, label(step.from), label(step.to)]),
    ).toEqual([
      ['call', 'Внешний клиент', 'RegistryHandler'],
      ['call', 'RegistryHandler', 'RegistryService'],
      ['call', 'RegistryService', 'RegistrationService'],
      ['return', 'RegistryHandler', 'Внешний клиент'],
    ]);
    expect(view.scenario.steps[0].from).toBe(view.scenario.steps.at(-1)!.to);
    expect(JSON.stringify(source)).toBe(original);
  });
  it('keeps request/response arrows visible when all internal calls are collapsed', () => {
    const view = sequenceView(scenario(), [index], new Set(['r']));
    expect(view.scenario.steps).toHaveLength(2);
    const [request, response] = view.scenario.steps;
    expect(request.to).toBe('r');
    expect(response.from).toBe('r');
    expect(response.to).toBe(request.from);
    const layout = sequenceParticipantLayout(view.participants);
    expect(layout.positions.get(request.from)!.x).toBeLessThan(layout.positions.get('r')!.x);
    expect(view.participants.some((participant) => participant.kind === 'class')).toBe(false);
  });
  it('replaces a direct controller self-loop without adding a duplicate request or inventing a response', () => {
    const s = scenario();
    s.steps = [{ ...s.steps[0], evidence: [controller], label: 'register' }];
    const view = sequenceView(s, [index]);
    expect(view.scenario.steps).toHaveLength(1);
    expect(view.scenario.steps[0].from).not.toBe(view.scenario.steps[0].to);
  });
  it('does not relabel ordinary self-invocation or ambiguous entry points as external calls', () => {
    expect(
      withExternalBoundary(scenario(), [{ ...index, methods: index.methods.slice(1) }]),
    ).toEqual(scenario());
    const ambiguous = {
      ...index,
      methods: [...index.methods, method(ref('OtherHandler.kt'), ['registryService.register'])],
    };
    expect(withExternalBoundary(scenario(), [ambiguous])).toEqual(scenario());
  });
  it('keeps an explicitly connected remote service as the caller', () => {
    const s = scenario();
    s.steps[0].from = 'remote';
    s.services.push('remote');
    expect(withExternalBoundary(s, [index])).toBe(s);
  });
  it('uses the response model, without request parameters, on return arrows', () => {
    const s = withExternalBoundary(scenario(), [index]);
    const response = sequenceMethod(s.steps.at(-1)!, [index], []);
    expect(response.label).toBe('register()');
    expect(response.inputs).toEqual([]);
    expect(response.outputs).toEqual([{ name: 'Response' }]);
  });
});
