import type { Evidence, IndexedMethod, Scenario, Snapshot, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';
import { isTestPath } from './test-coverage.js';
import { onHead, directlyChanged } from './analysis-scope.js';

export interface ScenarioRoot {
  id: string;
  name: string;
  evidence: Evidence;
  anchors: Evidence[];
  paths: string[];
}
const owner = (method: IndexedMethod) =>
  method.evidence.path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');
const key = (method: IndexedMethod) =>
  `${method.evidence.repoId}:${method.evidence.side}:${method.evidence.path}:${method.name}:${method.signature.replace(/\s+/g, ' ').trim()}`;

/** Enumerate affected public entries, not private helpers or framework-generated behavior. */
export function scenarioRoots(snapshots: Snapshot[], indexes: SourceIndex[]): ScenarioRoot[] {
  const all = indexes
    .flatMap((index) => index.methods)
    .filter((method) => !isTestPath(method.evidence.path));
  const byName = new Map<string, IndexedMethod[]>();
  for (const method of all) {
    const name = `${method.evidence.repoId}:${method.evidence.side}:${method.name}`;
    const values = byName.get(name) ?? [];
    values.push(method);
    byName.set(name, values);
  }
  const resolved = new Map<IndexedMethod, IndexedMethod[]>();
  const targets = (method: IndexedMethod) => {
    let found = resolved.get(method);
    if (found) return found;
    found = method.calls.flatMap((call) => {
      const parts = call.split('.'),
        name = parts.pop(),
        receiver = parts.join('.');
      const choices = (
        byName.get(`${method.evidence.repoId}:${method.evidence.side}:${name}`) ?? []
      ).filter((candidate) =>
        !receiver || receiver === 'this'
          ? candidate.evidence.path === method.evidence.path
          : owner(candidate).toLowerCase() === receiver.toLowerCase(),
      );
      return choices.length === 1 ? choices : [];
    });
    resolved.set(method, found);
    return found;
  };
  // Libraries expose public entry methods without HTTP/message entry annotations.
  // Require a changed body, so completion never expands into all library methods.
  const libraryEntry = (method: IndexedMethod) => {
    const snapshot = snapshots.find((s) => s.repoId === method.evidence.repoId);
    if (!snapshot || !directlyChanged(method, snapshots) || method.name === owner(method))
      return false;
    return (
      /(?:^|\/)(?:libs|libraries)\//.test(method.evidence.path) &&
      (/\bpublic\b/.test(method.signature) || method.evidence.path.endsWith('.kt'))
    );
  };
  const entries = all.filter(
    (method) =>
      !/\b(private|protected)\b/.test(method.signature) &&
      (libraryEntry(method) ||
        /(?:Handler|Controller)\.(java|kt)$/.test(method.evidence.path) ||
        method.annotations.some((annotation) =>
          /@(?:[\w.]+\.)?(?:Scheduled|KafkaListener|RabbitListener|JmsListener|GetMapping|PostMapping|RequestMapping|PutMapping|DeleteMapping|PatchMapping)\b/.test(
            annotation,
          ),
        )),
  );
  const direct = new Map(entries.map((entry) => [key(entry), targets(entry)]));
  // How many entries call each method directly: an anchor must identify one entry.
  const callers = new Map<string, number>();
  for (const entry of entries)
    for (const target of new Set((direct.get(key(entry)) ?? []).map(key)))
      callers.set(target, (callers.get(target) ?? 0) + 1);
  return entries.flatMap((entry) => {
    const snapshot = snapshots.find(
      (item) => item.repoId === entry.evidence.repoId && (item.pr || item.local),
    );
    if (!snapshot || (entry.evidence.side === 'base' && onHead(snapshot, entry.evidence.path)))
      return [];
    const reached = new Map<string, IndexedMethod>();
    const visit = (method: IndexedMethod) => {
      if (reached.has(key(method)) || reached.size >= 100) return;
      reached.set(key(method), method);
      targets(method).forEach(visit);
    };
    visit(entry);
    if (![...reached.values()].some((method) => directlyChanged(method, snapshots))) return [];
    const uniqueDirect = (direct.get(key(entry)) ?? []).filter(
      (target) => callers.get(key(target)) === 1,
    );
    return [
      {
        id: key(entry),
        name: `${owner(entry)}.${entry.name}`,
        evidence: entry.evidence,
        anchors: [entry.evidence, ...uniqueDirect.map((method) => method.evidence)],
        paths: [...new Set([...reached.values()].map((method) => method.evidence.path))],
      },
    ];
  });
}

export function missingScenarios(roots: ScenarioRoot[], scenarios: Scenario[]): ScenarioRoot[] {
  return roots.filter(
    (root) =>
      !scenarios.some((scenario) =>
        scenario.steps
          .flatMap((step) => step.evidence)
          .some((ref) => root.anchors.some((anchor) => overlaps(ref, anchor))),
      ),
  );
}
