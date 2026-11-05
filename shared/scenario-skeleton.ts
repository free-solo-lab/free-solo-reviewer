import type { Evidence, IndexedCall, IndexedMethod, Snapshot, SourceIndex } from './model.js';
import { activeMethods, calledMethods, directlyChanged, testPath } from './analysis-scope.js';
import type { ScenarioRoot } from './scenario-coverage.js';
import { databaseCall } from './sequence.js';

/** A call the index resolves unambiguously on the way from an entry to changed code. */
export interface SkeletonEdge {
  id: string;
  rootId: string;
  repoId: string;
  caller: string;
  callee: string;
  kind: 'call' | 'database';
  changed: boolean;
  evidence: Evidence[];
}
const MAX_EDGES = 40;
const owner = (m: IndexedMethod) =>
  m.evidence.path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');
const label = (m: IndexedMethod) => `${owner(m)}.${m.name}`;
const sameRef = (a: Evidence, b: Evidence) =>
  a.repoId === b.repoId &&
  a.side === b.side &&
  a.path === b.path &&
  a.startLine === b.startLine &&
  a.endLine === b.endLine;

/**
 * For each scenario root, the calls in source order that lead to changed methods, plus the
 * database calls made on that path. The model refers to them instead of rediscovering them.
 */
export function scenarioSkeletons(
  roots: ScenarioRoot[],
  snapshots: Snapshot[],
  indexes: SourceIndex[],
): SkeletonEdge[] {
  const all = activeMethods(snapshots, indexes).filter((m) => !testPath(m.evidence.path));
  const targetOf = (caller: IndexedMethod, call: IndexedCall) =>
    calledMethods(
      { ...caller, calls: [[call.receiver, call.name].filter(Boolean).join('.')] },
      all,
    )[0];
  const reaches = new Map<IndexedMethod, boolean>();
  const reachesChange = (m: IndexedMethod, path = new Set<IndexedMethod>()): boolean => {
    const known = reaches.get(m);
    if (known !== undefined) return known;
    if (path.has(m)) return false;
    path.add(m);
    const result =
      directlyChanged(m, snapshots) ||
      (m.callSites ?? []).some((call) => {
        const target = targetOf(m, call);
        return !!target && reachesChange(target, path);
      });
    path.delete(m);
    reaches.set(m, result);
    return result;
  };
  const edges: SkeletonEdge[] = [];
  for (const root of roots) {
    const entry = all.find((m) => sameRef(m.evidence, root.evidence));
    if (!entry) continue;
    const visited = new Set<IndexedMethod>();
    const walk = (method: IndexedMethod) => {
      if (visited.has(method)) return;
      visited.add(method);
      const calls = [...(method.callSites ?? [])].sort(
        (a, b) => a.evidence.startLine - b.evidence.startLine,
      );
      for (const call of calls) {
        if (edges.length >= MAX_EDGES) return;
        if (databaseCall(call)) {
          edges.push({
            id: `E${edges.length + 1}`,
            rootId: root.id,
            repoId: method.evidence.repoId,
            caller: label(method),
            callee: `${call.receiver.replace(/\s+/g, '').slice(0, 40)}.${call.name}`,
            kind: 'database',
            changed: directlyChanged(method, snapshots),
            evidence: [call.evidence],
          });
          continue;
        }
        const target = targetOf(method, call);
        if (!target || target === method || !reachesChange(target)) continue;
        // Calls inside one class are not drawn, but their outgoing calls are.
        if (target.evidence.path === method.evidence.path) {
          walk(target);
          continue;
        }
        edges.push({
          id: `E${edges.length + 1}`,
          rootId: root.id,
          repoId: method.evidence.repoId,
          caller: label(method),
          callee: label(target),
          kind: 'call',
          changed: directlyChanged(target, snapshots),
          evidence: [call.evidence, target.evidence],
        });
        walk(target);
      }
    };
    walk(entry);
  }
  return edges;
}
