import type { IndexedMethod, Snapshot, SourceIndex, ReviewSession, AnalysisRun } from './model.js';
import { patchLines } from './patch.js';

/** Test sources of JVM and frontend projects: test folders, `*Test.kt`, `*.spec.ts`, e2e suites. */
export const testPath = (path: string) =>
  /(?:^|\/)(?:test|tests|__tests__|__mocks__|e2e|cypress|playwright)\/|(?:Test|Tests|Spec)\.(?:java|kt)$|\.(?:test|spec|cy|e2e)\.[cm]?[jt]sx?$/.test(
    path,
  );
const keys = new WeakMap<IndexedMethod, string>();
const key = (m: IndexedMethod) => {
  let value = keys.get(m);
  if (value === undefined) keys.set(m, (value = JSON.stringify(m.evidence)));
  return value;
};
const owner = (m: IndexedMethod) =>
  m.evidence.path
    .split('/')
    .at(-1)!
    .replace(/\.(java|kt)$/, '');
const headPaths = new WeakMap<Snapshot, Set<string>>();
/** Base methods of files that still exist on head are superseded by their head version. */
export function onHead(snapshot: Snapshot, path: string) {
  let paths = headPaths.get(snapshot);
  if (!paths) headPaths.set(snapshot, (paths = new Set(snapshot.headFiles)));
  return paths.has(path);
}
export function activeMethods(snapshots: Snapshot[], indexes: SourceIndex[]) {
  const byRepo = new Map(snapshots.toReversed().map((s) => [s.repoId, s]));
  return indexes
    .flatMap((i) => i.methods)
    .filter((m) => {
      const s = byRepo.get(m.evidence.repoId);
      return s && (m.evidence.side === 'head' || !onHead(s, m.evidence.path));
    });
}
export function directlyChanged(m: IndexedMethod, snapshots: Snapshot[]) {
  const file = snapshots
    .find((s) => s.repoId === m.evidence.repoId)
    ?.files?.find(
      (f) => (m.evidence.side === 'head' ? f.path : (f.oldPath ?? f.path)) === m.evidence.path,
    );
  if (!file) return false;
  const lines = m.evidence.side === 'head' ? file.addedLines : file.removedLines;
  if (
    /^(?:A|D|added|removed)$/.test(file.status) ||
    lines.some((line) => line >= m.evidence.startLine && line <= m.evidence.endLine)
  )
    return true;
  // Deleted-only hunks have no addedLines. Map deleted body lines to the new side,
  // excluding a deletion immediately before the next method's declaration.
  if (m.evidence.side !== 'head') return false;
  for (const line of patchLines(file.patch ?? ''))
    if (
      line.kind === 'deletion' &&
      line.newLine > m.evidence.startLine &&
      line.newLine <= m.evidence.endLine
    )
      return true;
  return false;
}

/** Follow-up jobs review the delta between reviews, not the full original PR again. */
export function reviewScopeSnapshots(
  session: ReviewSession,
  run: AnalysisRun | null = session.run,
): Snapshot[] {
  if (run?.sourceChanges)
    return session.snapshots.map((s) => ({
      ...s,
      files: run.sourceChanges!.find((c) => c.repoId === s.repoId)?.files ?? [],
    }));
  if (
    !run?.previousReviewId ||
    session.update?.previousReviewId !== run.previousReviewId ||
    session.update.scopeChanged
  )
    return session.snapshots;
  return session.snapshots.map((snapshot) => ({
    ...snapshot,
    files: session.update!.changes.find((change) => change.repoId === snapshot.repoId)?.files ?? [],
  }));
}

interface CallResolver {
  byName: Map<string, IndexedMethod[]>;
  byPath: Map<string, IndexedMethod[]>;
  byOwner: Map<string, IndexedMethod[]>;
}
const group = (map: Map<string, IndexedMethod[]>, k: string, m: IndexedMethod) => {
  const values = map.get(k);
  if (values) values.push(m);
  else map.set(k, [m]);
};
const resolvers = new WeakMap<IndexedMethod[], CallResolver>();
function resolver(all: IndexedMethod[]) {
  let value = resolvers.get(all);
  if (!value) {
    value = { byName: new Map(), byPath: new Map(), byOwner: new Map() };
    for (const candidate of all) {
      const name = `${candidate.evidence.repoId}:${candidate.evidence.side}:${candidate.name}`;
      group(value.byName, name, candidate);
      group(value.byPath, `${name}:${candidate.evidence.path}`, candidate);
      group(value.byOwner, `${name}:${owner(candidate).toLowerCase()}`, candidate);
    }
    resolvers.set(all, value);
  }
  return value;
}
/** Resolve unambiguous local calls; do not connect common method names across services. */
export function calledMethods(m: IndexedMethod, all: IndexedMethod[]): IndexedMethod[] {
  const { byName, byPath, byOwner } = resolver(all);
  return m.calls.flatMap((call) => {
    const parts = call.split('.'),
      name = parts.pop(),
      receiver = parts.join('.');
    const scope = `${m.evidence.repoId}:${m.evidence.side}:${name}`;
    const named = byName.get(scope) ?? [];
    const candidates =
      (!receiver || receiver === 'this'
        ? byPath.get(`${scope}:${m.evidence.path}`)
        : byOwner.get(`${scope}:${receiver.toLowerCase()}`)) ?? [];
    return candidates.length === 1 ? candidates : receiver && named.length === 1 ? named : [];
  });
}
/** Changed production methods and callers leading to them; never unrelated outgoing branches. */
export function affectedProductionMethods(snapshots: Snapshot[], indexes: SourceIndex[]) {
  const all = activeMethods(snapshots, indexes).filter((m) => !testPath(m.evidence.path));
  const affected = new Set(all.filter((m) => directlyChanged(m, snapshots)).map(key));
  const edges = new Map(all.map((m) => [key(m), calledMethods(m, all)]));
  // Every caller of an affected method is affected, transitively.
  const callers = new Map<string, IndexedMethod[]>();
  for (const m of all)
    for (const c of edges.get(key(m))!) {
      const values = callers.get(key(c)) ?? [];
      values.push(m);
      callers.set(key(c), values);
    }
  const pending = [...affected];
  while (pending.length)
    for (const m of callers.get(pending.pop()!) ?? [])
      if (!affected.has(key(m))) {
        affected.add(key(m));
        pending.push(key(m));
      }
  return all.filter((m) => affected.has(key(m)));
}
export function relevantTestMethods(
  snapshots: Snapshot[],
  _indexes: SourceIndex[],
  tests: IndexedMethod[],
) {
  // Unchanged tests are not separate analysis targets, even when their fixture,
  // setup, production dependency or input model changed. Read those only as context.
  return tests.filter((method) => directlyChanged(method, snapshots));
}
