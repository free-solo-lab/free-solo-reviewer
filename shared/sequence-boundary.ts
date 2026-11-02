import type { Evidence, IndexedMethod, SourceIndex } from './model.js';
import { overlaps, type SequenceScenario } from './sequence.js';
const owner = (method: IndexedMethod) =>
  method.evidence.path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');
const endpoint = (method: IndexedMethod) =>
  /(?:Handler|Controller)\.(java|kt)$/.test(method.evidence.path) ||
  method.annotations.some((annotation) =>
    /^@(?:[\w.]+\.)?(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|MessageMapping)\b/.test(
      annotation,
    ),
  );
const key = (method: IndexedMethod) =>
  `${method.evidence.repoId}:${method.evidence.side}:${method.evidence.path}:${method.evidence.startLine}`;

/** Expose an API boundary only when a unique indexed entry/call chain supports it. */
export function withExternalBoundary(
  source: SequenceScenario,
  indexes: SourceIndex[],
): SequenceScenario {
  const first = source.steps[0];
  if (!first || first.kind !== 'call' || first.from !== first.to) return source;
  const origin = first.evidence.find((ref) => ref.repoId === first.from);
  if (!origin) return source;
  const methods = indexes
    .filter((index) => index.repoId === origin.repoId && index.side === origin.side)
    .flatMap((index) => index.methods);
  const targets = methods.filter((method) => overlaps(method.evidence, origin));
  if (targets.length !== 1) return source;
  const calls = (caller: IndexedMethod, callee: IndexedMethod) => {
    const matches = (name: string, receiver: string) =>
      name === callee.name &&
      (receiver.toLowerCase() === owner(callee).toLowerCase() ||
        ((!receiver || receiver === 'this') && caller.evidence.path === callee.evidence.path));
    const sites = caller.callSites?.filter((call) => matches(call.name, call.receiver));
    if (sites?.length === 1) return sites[0].evidence;
    if (
      !caller.callSites &&
      caller.calls.some((call) => {
        const parts = call.split('.');
        return matches(parts.at(-1)!, parts.slice(0, -1).join('.'));
      })
    )
      return caller.evidence;
    return null;
  };
  type Chain = { method: IndexedMethod; call?: Evidence }[];
  const paths: Chain[] = [];
  const visit = (path: Chain) => {
    const current = path[0].method;
    if (endpoint(current)) {
      paths.push(path);
      return;
    }
    if (path.length >= 5) return;
    for (const method of methods) {
      if (path.some((item) => key(item.method) === key(method))) continue;
      const call = calls(method, current);
      if (call) visit([{ method, call }, ...path]);
    }
  };
  visit([{ method: targets[0] }]);
  if (paths.length !== 1) return source;
  const chain = paths[0],
    entry = chain[0].method;
  const actor = `external:${encodeURIComponent(first.from)}:${encodeURIComponent(source.id)}`;
  const prefix: SequenceScenario['steps'] = [];
  // An explicit call from the handler to another class is not the entry itself.
  // Add the outside request before it instead of consuming that real delegation.
  const keepFirst =
    chain.length > 1 ||
    first.evidence.some(
      (ref) =>
        ref.repoId === entry.evidence.repoId &&
        ref.side === entry.evidence.side &&
        ref.path !== entry.evidence.path,
    );
  if (keepFirst) {
    prefix.push({
      ...first,
      id: `entry:${first.id}`,
      from: actor,
      to: first.to,
      label: `${owner(entry)}.${entry.name}`,
      evidence: [entry.evidence],
      confidence: 'inferred',
      branch: '',
    });
    for (let i = 0; i < chain.length - 1; i++) {
      const caller = chain[i],
        callee = chain[i + 1].method;
      prefix.push({
        ...first,
        id: `entry:${first.id}:${i}`,
        label: `${owner(caller.method)} → ${owner(callee)}.${callee.name}`,
        evidence: [caller.call ?? caller.method.evidence, callee.evidence],
        confidence: 'inferred',
        branch: '',
      });
    }
  }
  const steps = source.steps.map((step, index) => {
    if (index === 0 && !keepFirst)
      return {
        ...step,
        from: actor,
        label: `${owner(entry)}.${entry.name}`,
        evidence: [entry.evidence],
        confidence: 'inferred' as const,
      };
    if (
      step.kind === 'return' &&
      step.from === first.from &&
      step.to === first.to &&
      step.evidence.some((ref) => overlaps(ref, entry.evidence))
    ) {
      return {
        ...step,
        to: actor,
        label: `${owner(entry)}.${entry.name}`,
        evidence: [entry.evidence, ...step.evidence],
      };
    }
    return step;
  });
  return { ...source, services: [actor, ...source.services], steps: [...prefix, ...steps] };
}
