import type { Evidence, IndexedMethod, ReviewTest, Scenario, Snapshot, SourceIndex } from './model';
import { directlyChanged } from './analysis-scope';
import { sequenceMethod } from './sequence-method';
import type { SourceDiffRow } from './source-diff';
import { methodDefinitions } from './code-navigation';

export interface ScenarioCodeEntry {
  id: string;
  label: string;
  evidence: Evidence;
  ranges: Evidence[];
}
const sameFile = (a: Evidence, b: Evidence) =>
  a.repoId === b.repoId && a.path === b.path && a.side === b.side;
const inside = (ref: Evidence, range: Evidence) =>
  sameFile(ref, range) && ref.startLine >= range.startLine && ref.endLine <= range.endLine;
const methodLabel = (method: IndexedMethod) =>
  `${method.owner?.split('.').pop() ?? method.evidence.path.split('/').pop()}.${method.name}()`;

/** Only source changes explicitly belonging to the scenario, in call order, once per method. */
export function scenarioCodeEntries(
  scenario: Scenario,
  snapshots: Snapshot[],
  indexes: SourceIndex[],
): ScenarioCodeEntry[] {
  const methods = indexes.flatMap((index) => index.methods);
  const entries: ScenarioCodeEntry[] = [];
  const seen = new Set<string>();
  const addOne = (method: IndexedMethod) => {
    const snapshot = snapshots.find((item) => item.repoId === method.evidence.repoId);
    if (!snapshot) return;
    const file = snapshot.files.find(
      (item) =>
        (method.evidence.side === 'head' ? item.path : (item.oldPath ?? item.path)) ===
        method.evidence.path,
    );
    if (!file) return;
    const pairs = methods.filter(
      (candidate) =>
        candidate.evidence.repoId === method.evidence.repoId &&
        candidate.evidence.side !== method.evidence.side &&
        candidate.name === method.name &&
        candidate.evidence.path ===
          (method.evidence.side === 'head' ? (file.oldPath ?? file.path) : file.path),
    );
    const counterpart = pairs.length === 1 ? pairs[0] : undefined;
    const ranges = [method.evidence, ...(counterpart ? [counterpart.evidence] : [])];
    // A surviving method is reviewed on head; removed methods retain their base evidence.
    if (method.evidence.side === 'base' && counterpart) method = counterpart;
    if (!directlyChanged(method, snapshots)) return;
    const key = JSON.stringify(method.evidence);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      id: key,
      label: methodLabel(method),
      evidence: method.evidence,
      ranges,
    });
  };
  const add = (method: IndexedMethod) => {
    addOne(method);
    const type = indexes
      .filter(
        (index) => index.repoId === method.evidence.repoId && index.side === method.evidence.side,
      )
      .flatMap((index) => index.types ?? [])
      .find((type) => type.qualifiedName === method.owner);
    if (type?.kind === 'interface') {
      for (const implementation of methodDefinitions(method, indexes)) addOne(implementation);
    }
  };
  const references = (refs: Evidence[]) => {
    for (const ref of refs) {
      const owners = methods.filter((method) => inside(ref, method.evidence));
      if (owners.length) {
        owners.forEach(add);
        continue;
      }
      // JVM file-wide evidence must not pull unrelated changed methods into the scenario.
      if (
        /\.(java|kt)$/.test(ref.path) &&
        methods.some(
          (method) =>
            sameFile(method.evidence, ref) &&
            ref.startLine <= method.evidence.endLine &&
            ref.endLine >= method.evidence.startLine,
        )
      )
        continue;
      if (
        !directlyChanged(
          { name: '', signature: '', calls: [], annotations: [], evidence: ref },
          snapshots,
        )
      )
        continue;
      const key = JSON.stringify(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ id: key, label: ref.path.split('/').pop()!, evidence: ref, ranges: [ref] });
    }
  };
  for (const step of scenario.steps) {
    if (step.kind === 'return') continue;
    references(step.evidence);
    const resolved = sequenceMethod(step, indexes, snapshots).evidence;
    if (resolved) {
      const method = methods.find(
        (method) =>
          sameFile(method.evidence, resolved) && method.evidence.startLine === resolved.startLine,
      );
      if (method) add(method);
    }
  }
  references(scenario.evidence);
  return entries;
}

/** The test's own methods, each whole, in the order the analysis names them. */
export function testCodeEntries(test: ReviewTest, indexes: SourceIndex[]): ScenarioCodeEntry[] {
  const methods = indexes.flatMap((index) => index.methods);
  const entries = new Map<string, ScenarioCodeEntry>();
  for (const ref of test.evidence) {
    // The innermost method holding the reference: a test, not the class around a nested one.
    const owner = methods
      .filter((method) => inside(ref, method.evidence))
      .sort(
        (a, b) =>
          a.evidence.endLine - a.evidence.startLine - (b.evidence.endLine - b.evidence.startLine),
      )[0];
    const evidence = owner?.evidence ?? ref;
    const id = JSON.stringify(evidence);
    if (!entries.has(id))
      entries.set(id, {
        id,
        label: owner ? methodLabel(owner) : ref.path.split('/').pop()!,
        evidence,
        ranges: [evidence],
      });
  }
  return [...entries.values()];
}

/** Preserve full-file line numbers and opposite-side deletions inside the selected method. */
export function scopedSourceRows(rows: SourceDiffRow[], ranges?: Evidence[]) {
  if (!ranges) return rows;
  const native = rows.find((item) => item.native)?.evidence;
  let anchor = rows.filter((row) => row.native).at(-1)?.evidence.startLine ?? 1;
  return rows
    .map((row) => ({ row, anchor: 0 }))
    .reverse()
    .map((entry) => {
      if (entry.row.native) anchor = entry.row.evidence.startLine;
      return { ...entry, anchor };
    })
    .reverse()
    .filter(({ row, anchor }) => {
      if (ranges.some((range) => inside(row.evidence, range))) return true;
      if (row.native || ranges.some((range) => sameFile(range, row.evidence))) return false;
      return (
        !!native &&
        ranges.some(
          (range) =>
            sameFile(range, native) && anchor >= range.startLine && anchor <= range.endLine,
        )
      );
    })
    .map(({ row }) => row);
}
