import { describe, expect, it } from 'vitest';
import type { Evidence, Scenario, SourceIndex } from '../shared/model';
import {
  sequenceActivations,
  sequenceEntry,
  sequenceReturns,
} from '../shared/sequence-activations';

type Step = Scenario['steps'][number];
const step = (from: string, to: string, kind: Step['kind'] = 'call', evidence: Evidence[] = []) =>
  ({
    id: `${from}-${to}`,
    from,
    to,
    label: '',
    kind,
    change: 'unchanged',
    branch: '',
    confidence: 'extracted',
    evidence,
  }) as Step;
const ref = (path: string, startLine: number, endLine = startLine): Evidence =>
  ({ repoId: 'repo', side: 'head', path, startLine, endLine }) as Evidence;

describe('sequence activations', () => {
  it('keeps the caller active while its callee calls further, and skips single calls', () => {
    // Visitor -> Funcs -> Aggregator, then Visitor -> Funcs again -> other Aggregator.
    const bars = sequenceActivations([
      step('Visitor', 'Funcs'),
      step('Funcs', 'Count'),
      step('Visitor', 'Funcs'),
      step('Funcs', 'CountPayout'),
    ]);
    // The aggregators make no further calls, so they get no bar: the arrow shows their result.
    expect(bars).toEqual([
      { lane: 'Visitor', caller: '', start: -1, end: 3, depth: 0, returned: false },
      { lane: 'Funcs', caller: 'Visitor', start: 0, end: 1, depth: 0, returned: false },
      { lane: 'Funcs', caller: 'Visitor', start: 2, end: 3, depth: 0, returned: false },
    ]);
    // Each bar ends with an answer to its caller; the ones ending together are stacked, inner first.
    expect(sequenceReturns(bars).map(({ lane, end, rank }) => [lane, end, rank])).toEqual([
      ['Funcs', 1, 0],
      ['Funcs', 3, 0],
      ['Visitor', 3, 1],
    ]);
  });

  it('draws no answer for a call the scenario already returns from', () => {
    const bars = sequenceActivations([
      step('A', 'B'),
      step('B', 'B'),
      step('B', 'C'),
      step('C', 'B', 'return'),
      step('B', 'A', 'return'),
    ]);
    expect(bars).toContainEqual({
      lane: 'B',
      caller: 'A',
      start: 0,
      end: 4,
      depth: 0,
      returned: true,
    });
    // The call into its own method and C make no further calls.
    expect(bars.map((bar) => bar.lane)).toEqual(['A', 'B']);
    expect(sequenceReturns(bars).map((bar) => bar.lane)).toEqual(['A']);
  });

  it('finds the entry method of the starting class around the first call', () => {
    const index = {
      repoId: 'repo',
      side: 'head',
      methods: [
        { name: 'visitCountPayouts', evidence: ref('Visitor.java', 10, 30) },
        { name: 'other', evidence: ref('Visitor.java', 40, 50) },
      ],
    } as unknown as SourceIndex;
    const steps = [step('Visitor', 'Funcs', 'call', [ref('Visitor.java', 15)])];
    expect(sequenceEntry(steps, [index], ref('Visitor.java', 1))?.name).toBe('visitCountPayouts');
    expect(sequenceEntry(steps, [index], ref('Other.java', 1))).toBeNull();
  });
});
