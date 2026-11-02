import type { Evidence, IndexedCall, IndexedMethod, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';

export interface IndexedCallEdge {
  caller: IndexedMethod;
  callee: IndexedMethod;
  call: IndexedCall;
}
const owner = (method: IndexedMethod) =>
  method.evidence.path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '')
    .toLowerCase();

/** Follow only a unique chain whose actual invocation sites are cited by this step. */
export function indexedCallChain(
  refs: Evidence[],
  target: IndexedMethod,
  indexes: SourceIndex[],
): IndexedCallEdge[] {
  const methods = indexes
    .filter(
      (index) => index.repoId === target.evidence.repoId && index.side === target.evidence.side,
    )
    .flatMap((index) => index.methods);
  const referenced = methods.filter((method) => refs.some((ref) => overlaps(ref, method.evidence)));
  const edges = referenced.flatMap((caller) =>
    (caller.callSites ?? [])
      .filter((call) => refs.some((ref) => overlaps(ref, call.evidence)))
      .flatMap((call) => {
        const targets = methods.filter(
          (callee) =>
            callee.name === call.name &&
            (!call.receiver || call.receiver === 'this'
              ? callee.evidence.path === caller.evidence.path
              : owner(callee) === call.receiver.toLowerCase()),
        );
        return targets.length === 1 && referenced.includes(targets[0]) && targets[0] !== caller
          ? [{ caller, callee: targets[0], call }]
          : [];
      }),
  );
  const chain: IndexedCallEdge[] = [],
    seen = new Set<IndexedMethod>();
  let current = target;
  while (true) {
    if (seen.has(current) || chain.length > 8) return [];
    seen.add(current);
    const incoming = edges.filter((edge) => edge.callee === current);
    if (!incoming.length) return chain.reverse();
    // Repeated calls, overloads and alternative callers cannot be ordered by guessing.
    if (incoming.length !== 1) return [];
    chain.push(incoming[0]);
    current = incoming[0].caller;
  }
}

export function sameInvocation(a: Evidence, b: Evidence) {
  return overlaps(a, b) && a.startLine === b.startLine && a.endLine === b.endLine;
}
