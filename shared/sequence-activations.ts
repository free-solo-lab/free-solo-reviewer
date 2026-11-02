import type { Evidence, Scenario, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';

type Step = Scenario['steps'][number];

/** A period in which a participant executes a call: from its incoming step to its last nested one. */
export interface SequenceActivation {
  lane: string;
  /** The participant that made the call and receives the answer; '' for the entry call. */
  caller: string;
  /** Index of the step that started it; -1 for the entry call into the scenario. */
  start: number;
  end: number;
  /** Nesting on the same lifeline, e.g. a class calling its own method. */
  depth: number;
  /** Closed by a return step of the scenario itself, so no answer arrow is drawn for it. */
  returned: boolean;
}

/**
 * Activation bars of a sequence diagram. Steps are a flat list, so nesting follows the call order:
 * a call from a participant that is not the innermost active one returns from everything above it.
 * Only calls that make further calls get a bar; a single call already shows its result on its arrow.
 */
export function sequenceActivations(steps: Step[]): SequenceActivation[] {
  type Frame = SequenceActivation & { calls: number };
  const result: Frame[] = [];
  const stack: Frame[] = [];
  const depthOf = (lane: string) => stack.filter((frame) => frame.lane === lane).length;
  const closeAbove = (lane: string, end: number, returned = false) => {
    while (stack.length && stack.at(-1)!.lane !== lane) {
      const frame = stack.pop()!;
      result.push({ ...frame, end: Math.max(frame.start, end), returned });
      returned = false; // only the innermost call is the one that returned
    }
  };
  steps.forEach((step, i) => {
    if (step.kind === 'return') {
      if (stack.some((frame) => frame.lane === step.to)) closeAbove(step.to, i, true);
      return;
    }
    if (stack.some((frame) => frame.lane === step.from)) closeAbove(step.from, i - 1);
    else {
      closeAbove('', i - 1);
      const entry = !result.length && !i;
      stack.push({
        lane: step.from,
        caller: '',
        start: entry ? -1 : i,
        end: i,
        depth: 0,
        returned: !entry, // a new chain without an entry arrow has no caller to answer
        calls: 0,
      });
    }
    stack.at(-1)!.calls++;
    if (step.kind === 'event') return;
    const frame = {
      lane: step.to,
      caller: step.from,
      start: i,
      end: i,
      depth: depthOf(step.to),
      returned: false,
      calls: 0,
    };
    // A query or a call into the same object ends with this step; other calls may nest.
    if (step.kind === 'database' || step.from === step.to) result.push(frame);
    else stack.push(frame);
  });
  closeAbove('', steps.length - 1);
  return result
    .filter((frame) => frame.calls > 0)
    .map(({ calls: _calls, ...frame }) => frame)
    .sort((a, b) => a.start - b.start || a.depth - b.depth);
}

/** Answers drawn at the ends of the bars; several ending at one step are stacked, inner first. */
export function sequenceReturns(activations: SequenceActivation[]) {
  const answers = activations
    .filter((bar) => !bar.returned)
    .sort((a, b) => a.end - b.end || b.start - a.start);
  return answers.map((bar) => ({
    ...bar,
    rank: answers.filter((other) => other.end === bar.end && other.start > bar.start).length,
  }));
}

/** The method of the starting participant that contains the first call: the scenario's entry. */
export function sequenceEntry(
  steps: Step[],
  indexes: SourceIndex[],
  laneEvidence?: Evidence,
): { name: string; evidence: Evidence } | null {
  const first = steps.find((step) => step.kind !== 'return');
  if (!first) return null;
  const methods = indexes.flatMap((index) => index.methods);
  const containing = (ref: Evidence) =>
    methods.filter(
      (method) =>
        method.evidence.repoId === ref.repoId &&
        method.evidence.path === ref.path &&
        method.evidence.side === ref.side &&
        overlaps(method.evidence, ref),
    );
  const refs = laneEvidence
    ? first.evidence.filter((ref) => ref.path === laneEvidence.path)
    : first.evidence;
  for (const ref of refs) {
    // The innermost method, if a lambda or an inner class nests inside another.
    const method = containing(ref).sort(
      (a, b) =>
        a.evidence.endLine - a.evidence.startLine - (b.evidence.endLine - b.evidence.startLine),
    )[0];
    if (method) return { name: method.name, evidence: method.evidence };
  }
  return null;
}
