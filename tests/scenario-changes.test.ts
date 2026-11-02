import { describe, expect, it } from 'vitest';
import { scenarioChanges, scenarioStepMeaning } from '../shared/scenario-changes';
import type { Scenario, SourceIndex } from '../shared/model';
const ref = {
  repoId: 'repo',
  path: 'Service.java',
  side: 'head' as const,
  startLine: 10,
  endLine: 12,
};
const step = (id: string, label: string): Scenario['steps'][number] => ({
  id,
  label,
  kind: 'call',
  from: 'repo',
  to: 'remote',
  branch: '',
  change: 'added',
  confidence: 'inferred',
  evidence: [ref],
});
const scenario: Scenario = {
  id: 'flow',
  title: 'Flow',
  summary: 'Before',
  confidence: 'inferred',
  services: ['repo', 'remote'],
  evidence: [ref],
  steps: [step('a', 'save()'), step('b', 'notify()')],
};
describe('scenario changes since reviewed version', () => {
  it('matches renamed scenarios by their entry method and ignores rewritten labels for the same invocation', () => {
    const root = {
      id: 'handler.entry',
      name: 'Handler.entry',
      evidence: ref,
      anchors: [ref],
      paths: [ref.path],
    };
    const index: SourceIndex = {
      repoId: 'repo',
      side: 'head',
      errors: [],
      filesIndexed: 1,
      methods: [
        { name: 'save', signature: 'String save()', calls: [], annotations: [], evidence: ref },
      ],
    };
    const previous = { ...scenario, steps: [step('old-call', 'Save record')] };
    const current = {
      ...previous,
      id: 'new-id',
      title: 'New title',
      steps: [step('new-call', 'Service.save')],
    };
    const fingerprints = {
      current: (step: Scenario['steps'][number]) => scenarioStepMeaning(step, [index], []),
      previous: (step: Scenario['steps'][number]) => scenarioStepMeaning(step, [index], []),
    };
    const delta = scenarioChanges(
      [current],
      [previous],
      [],
      { current: [root], previous: [root] },
      fingerprints,
    ).get('new-id')!;
    expect(delta.previous?.id).toBe(previous.id);
    expect(delta.steps.size).toBe(0);
    expect(delta.removed).toEqual([]);
  });
  it('highlights deletion-only fixes but never treats merge-base coordinates as previous-head coordinates', () => {
    const current = { ...scenario, steps: [step('a', 'save()')] };
    const changes = [
      {
        repoId: 'repo',
        fromSha: 'old',
        toSha: 'new',
        files: [
          {
            path: ref.path,
            status: 'M',
            addedLines: [],
            removedLines: [11],
            patch: '@@ -10,3 +10,2 @@\n keep\n-bad()\n done',
          },
        ],
      },
    ];
    expect(scenarioChanges([current], [current], changes).get('flow')?.steps.get('a')).toBe(
      'modified',
    );
    const base = structuredClone(current);
    base.evidence = [{ ...ref, side: 'base' }];
    base.steps[0].evidence = [{ ...ref, side: 'base' }];
    expect(scenarioChanges([base], [base], changes).size).toBe(0);
  });

  it('ignores line shifts, confidence and regenerated step IDs', () => {
    const shifted = structuredClone(scenario);
    shifted.steps.forEach((item) => {
      item.id += '-new';
      item.confidence = 'unknown';
      item.evidence[0].startLine += 50;
      item.evidence[0].endLine += 50;
    });
    shifted.evidence[0].startLine += 50;
    expect(scenarioChanges([shifted], [scenario]).size).toBe(0);
  });
  it('distinguishes changed, added and removed calls and detects a code fix with unchanged labels', () => {
    const updated = {
      ...scenario,
      summary: 'After',
      steps: [step('a', 'saveSafely()'), step('c', 'audit()')],
    };
    const delta = scenarioChanges([updated], [scenario]).get('flow')!;
    expect([...delta.steps]).toEqual([
      ['a', 'modified'],
      ['c', 'added'],
    ]);
    expect(delta.removed.map((item) => item.id)).toEqual(['b']);
    const changes = [
      {
        repoId: 'repo',
        fromSha: 'old',
        toSha: 'new',
        files: [
          { path: 'Service.java', status: 'M', patch: '', addedLines: [11], removedLines: [11] },
        ],
      },
    ];
    expect(scenarioChanges([scenario], [scenario], changes).get('flow')!.steps.get('a')).toBe(
      'modified',
    );
    expect(scenarioChanges([scenario], []).get('flow')!.kind).toBe('added');
  });
});
