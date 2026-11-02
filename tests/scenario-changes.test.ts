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
    );
    expect(delta.size).toBe(0);
  });
  it('ignores regenerated titles and summaries even without a source catalog', () => {
    expect(
      scenarioChanges(
        [{ ...scenario, title: 'Another name', summary: 'Rewritten prose' }],
        [scenario],
      ).size,
    ).toBe(0);
  });
  it('matches regenerated IDs by an unambiguous call sequence when entry evidence is missing', () => {
    const current = { ...scenario, id: 'regenerated', title: 'Reworded', summary: 'New prose' };
    expect(scenarioChanges([current], [scenario]).size).toBe(0);
    expect(
      scenarioChanges([current], [scenario, { ...scenario, id: 'another' }]).get(current.id)?.kind,
    ).toBe('added');
  });
  it('recognises the entry despite broad references to adjacent entries and shared callees', () => {
    const root = (name: string, line: number) => ({
      id: `repo:Handler.java:${name}`,
      name: `Handler.${name}`,
      evidence: { ...ref, path: 'Handler.java', startLine: line, endLine: line + 5 },
      anchors: [ref],
      paths: [ref.path],
    });
    const download = root('download', 10),
      get = root('get', 20);
    const old = {
      ...scenario,
      id: 'old-download',
      title: 'Download old',
      steps: [
        { ...step('a', 'Handler.download -> Service.save'), evidence: [download.evidence, ref] },
      ],
    };
    const current = {
      ...old,
      id: 'new-download',
      title: 'New download title',
      summary: 'New prose',
      steps: [
        {
          ...step('new-a', 'Handler.download -> Service.save'),
          evidence: [{ ...download.evidence, endLine: 25 }, ref],
        },
      ],
    };
    const other = {
      ...scenario,
      id: 'get',
      steps: [{ ...step('g', 'Handler.get -> Service.save'), evidence: [get.evidence, ref] }],
    };
    const roots = { previous: [download, get], current: [download, get] };
    const fingerprints = { previous: () => 'same-call', current: () => 'same-call' };
    expect(scenarioChanges([current, other], [old, other], [], roots, fingerprints).size).toBe(0);
    const change = [
      {
        repoId: 'repo',
        fromSha: 'old',
        toSha: 'new',
        files: [{ path: ref.path, status: 'M', patch: '', addedLines: [11], removedLines: [] }],
      },
    ];
    const delta = scenarioChanges([current, other], [old, other], change, roots, fingerprints).get(
      'new-download',
    )!;
    expect(delta.kind).toBe('modified');
    expect(delta.previous?.id).toBe('old-download');
  });
  it('does not mark added detail or an existing entry discovered by a later analysis as new code', () => {
    const root = {
      id: 'entry',
      name: 'Service.save',
      evidence: ref,
      anchors: [ref],
      paths: [ref.path],
    };
    const roots = { current: [root], previous: [root] };
    const fingerprints = {
      current: (s: Scenario['steps'][number]) => s.label,
      previous: (s: Scenario['steps'][number]) => s.label,
    };
    const detailed = { ...scenario, steps: [...scenario.steps, step('detail', 'Extra detail')] };
    expect(scenarioChanges([detailed], [scenario], [], roots, fingerprints).size).toBe(0);
    expect(scenarioChanges([detailed], [], [], roots, fingerprints).size).toBe(0);
    expect(
      scenarioChanges([detailed], [], [], { ...roots, previous: [] }, fingerprints).get('flow')
        ?.kind,
    ).toBe('added');
  });
  it('does not highlight newly generated detail in unchanged methods when a different step changed', () => {
    const root = {
      id: 'entry',
      name: 'Service.save',
      evidence: ref,
      anchors: [ref],
      paths: [ref.path],
    };
    const roots = { current: [root], previous: [root] };
    const fingerprints = {
      current: (s: Scenario['steps'][number]) => s.label,
      previous: (s: Scenario['steps'][number]) => s.label,
    };
    const extra = {
      ...step('new-detail', 'Converter.convert'),
      evidence: [{ ...ref, path: 'Converter.java' }],
    };
    const updated = { ...scenario, steps: [scenario.steps[0], extra] };
    const changes = [
      {
        repoId: 'repo',
        fromSha: 'old',
        toSha: 'new',
        files: [{ path: ref.path, status: 'M', patch: '', addedLines: [11], removedLines: [] }],
      },
    ];
    const delta = scenarioChanges([updated], [scenario], changes, roots, fingerprints).get('flow')!;
    expect(delta.kind).toBe('modified');
    expect(delta.steps.get('a')).toBe('modified');
    expect(delta.steps.has('new-detail')).toBe(false);
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
