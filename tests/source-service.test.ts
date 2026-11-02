import { expect, it } from 'vitest';
import { sourceService, scenarioService } from '../shared/source-service';
import { sequenceView } from '../shared/sequence-view';
import type { Snapshot, Scenario, Evidence } from '../shared/model';
const snapshot = {
  repoId: 'project',
  repoName: 'ledger-project',
  headFiles: ['pom.xml', 'apps/warehouse-manager/pom.xml', 'apps/ledger/pom.xml'],
  baseFiles: [],
} as unknown as Snapshot;
const ref = (path: string): Evidence => ({
  repoId: 'project',
  path,
  side: 'head',
  startLine: 1,
  endLine: 8,
});
const a = ref('apps/warehouse-manager/src/main/java/Handler.java'),
  b = ref('apps/ledger/src/main/java/Service.java');
const scenario = {
  id: 's',
  title: 'Call',
  summary: '',
  services: ['project'],
  confidence: 'inferred',
  evidence: [a, b],
  steps: [
    {
      id: 'call',
      from: 'project',
      to: 'project',
      label: 'Handler → Service: run',
      kind: 'call',
      change: 'added',
      branch: '',
      confidence: 'inferred',
      evidence: [a, b],
    },
  ],
} as Scenario;
it('uses the nearest module, preserving the canonical repository identity', () => {
  expect(sourceService(snapshot, a.path)).toMatchObject({
    name: 'warehouse-manager',
    repoId: 'project',
  });
  expect(sourceService(snapshot, b.path).name).toBe('ledger');
  expect(sourceService(snapshot, 'README.md').name).toBe('ledger-project');
  expect(scenarioService([snapshot], scenario)?.name).toBe('warehouse-manager');
});
it('keeps classes of different services in separate diagram containers without changing evidence', () => {
  const view = sequenceView(scenario, [], new Set(), [snapshot]);
  expect(view.participants.filter((p) => p.kind === 'service').map((p) => p.label)).toEqual([
    'warehouse-manager',
    'ledger',
  ]);
  const classes = view.participants.filter((p) => p.kind === 'class');
  expect(new Set(classes.map((p) => p.owner)).size).toBe(2);
  expect(classes.every((p) => p.evidence?.repoId === 'project')).toBe(true);
  expect(scenario.services).toEqual(['project']);
});
