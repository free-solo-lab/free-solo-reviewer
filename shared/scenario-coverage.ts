import type { Evidence, IndexedMethod, Scenario, Snapshot, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';
import { isTestPath } from './test-coverage.js';

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
  `${method.evidence.repoId}:${method.evidence.side}:${method.evidence.path}:${method.name}`;

/** Enumerate affected public entries, not private helpers or framework-generated behavior. */
export function scenarioRoots(snapshots: Snapshot[], indexes: SourceIndex[]): ScenarioRoot[] {
  const all = indexes
    .flatMap((index) => index.methods)
    .filter((method) => !isTestPath(method.evidence.path));
  const targets = (method: IndexedMethod) =>
    method.calls.flatMap((call) => {
      const parts = call.split('.'),
        name = parts.pop(),
        receiver = parts.join('.');
      const choices = all.filter(
        (candidate) =>
          candidate.evidence.repoId === method.evidence.repoId &&
          candidate.evidence.side === method.evidence.side &&
          candidate.name === name &&
          (!receiver || receiver === 'this'
            ? candidate.evidence.path === method.evidence.path
            : owner(candidate).toLowerCase() === receiver.toLowerCase()),
      );
      return choices.length === 1 ? choices : [];
    });
  const entries = all.filter(
    (method) =>
      !/\b(private|protected)\b/.test(method.signature) &&
      (/(?:Handler|Controller)\.(java|kt)$/.test(method.evidence.path) ||
        method.annotations.some((annotation) =>
          /@(?:[\w.]+\.)?(?:Scheduled|KafkaListener|RabbitListener|JmsListener|GetMapping|PostMapping|RequestMapping|PutMapping|DeleteMapping|PatchMapping)\b/.test(
            annotation,
          ),
        )),
  );
  const direct = new Map(entries.map((entry) => [key(entry), targets(entry)]));
  return entries.flatMap((entry) => {
    const snapshot = snapshots.find((item) => item.repoId === entry.evidence.repoId && item.pr);
    if (
      !snapshot ||
      (entry.evidence.side === 'base' && snapshot.headFiles.includes(entry.evidence.path))
    )
      return [];
    const changed = new Set(
      snapshot.files.flatMap((file) => [file.path, file.oldPath ?? file.path]),
    );
    const reached = new Map<string, IndexedMethod>();
    const visit = (method: IndexedMethod) => {
      if (reached.has(key(method)) || reached.size >= 100) return;
      reached.set(key(method), method);
      targets(method).forEach(visit);
    };
    visit(entry);
    if (![...reached.values()].some((method) => changed.has(method.evidence.path))) return [];
    const uniqueDirect = (direct.get(key(entry)) ?? []).filter(
      (target) =>
        entries.filter((other) =>
          (direct.get(key(other)) ?? []).some((candidate) => key(candidate) === key(target)),
        ).length === 1,
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
