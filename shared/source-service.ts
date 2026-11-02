import type { Evidence, Scenario, Snapshot } from './model.js';

/** Resolve presentation boundaries without changing canonical repository/code references. */
export function sourceService(snapshot: Snapshot, path: string) {
  const dirs = [
    ...new Set(
      [...snapshot.headFiles, ...snapshot.baseFiles]
        .filter(
          (p) =>
            /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|package\.json)$/.test(p) &&
            !p.includes('node_modules/'),
        )
        .map((p) => p.slice(0, p.lastIndexOf('/') + 1)),
    ),
  ];
  const build = dirs
    .filter((dir) => dir && path.startsWith(dir))
    .sort((a, b) => b.length - a.length)[0];
  const inferred = path.match(/^(.*?(?:^|\/)(?:apps|services|modules|infra)\/[^/]+)\//)?.[1];
  const dir = build?.replace(/\/$/, '') ?? inferred ?? '';
  return {
    id: dir ? `service:${snapshot.repoId}:${encodeURIComponent(dir)}` : snapshot.repoId,
    name: dir ? dir.split('/').at(-1)! : snapshot.repoName,
    dir,
    repoId: snapshot.repoId,
  };
}
export function evidenceService(snapshots: Snapshot[], ref?: Evidence) {
  const snapshot = snapshots.find((s) => s.repoId === ref?.repoId);
  return snapshot && ref ? sourceService(snapshot, ref.path) : undefined;
}
export function scenarioService(snapshots: Snapshot[], scenario: Scenario) {
  const first = scenario.steps.find((s) => s.kind !== 'return');
  const ref =
    scenario.evidence.find((e) => e.repoId === first?.from && /\.(java|kt)$/.test(e.path)) ??
    scenario.evidence.find((e) => /\.(java|kt)$/.test(e.path)) ??
    first?.evidence.find((e) => /\.(java|kt)$/.test(e.path)) ??
    scenario.evidence[0];
  return evidenceService(snapshots, ref);
}
