import { calledMethods } from '../shared/analysis-scope.js';
import type {
  Evidence,
  ModelResult,
  ReviewRevision,
  Snapshot,
  SourceIndex,
} from '../shared/model.js';
import {
  containingMethod,
  evidenceIn,
  methodIdentity,
  remapEvidence,
  replaceEvidence,
} from './source-remap.js';
import { t } from '../shared/i18n.js';

async function sameMethodTree(
  method: import('../shared/model.js').IndexedMethod,
  previous: ReviewRevision,
  current: Snapshot[],
  seen = new Set<string>(),
): Promise<boolean> {
  const key = methodIdentity(method);
  if (seen.has(key)) return true;
  seen.add(key);
  const ref = method.evidence,
    before = previous.snapshots.find((s) => s.repoId === ref.repoId),
    after = current.find((s) => s.repoId === ref.repoId);
  if (!before || !after || !(await remapEvidence(before, after, ref))) return false;
  // Parameter/result models affect the meaning of a call even when its method body stays.
  const names = new Set(method.signature.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const types = previous.run.result.indexes
    .flatMap((i) => i.types ?? [])
    .filter(
      (type) =>
        type.evidence.repoId === ref.repoId &&
        type.evidence.side === ref.side &&
        names.has(type.name) &&
        !(
          type.evidence.path === ref.path &&
          type.evidence.startLine <= ref.startLine &&
          type.evidence.endLine >= ref.endLine
        ),
    );
  for (const type of types) if (!(await remapEvidence(before, after, type.evidence))) return false;
  const all = previous.run.result.indexes.flatMap((i) => i.methods);
  for (const dependency of calledMethods(method, all))
    if (!(await sameMethodTree(dependency, previous, current, seen))) return false;
  return true;
}

/** Preserve untouched semantic text; source anchors move only with unambiguous exact code. */
export async function mergeIncremental(
  previous: ReviewRevision,
  current: Snapshot[],
  delta: ModelResult,
  indexes: SourceIndex[] = previous.run.result.indexes,
): Promise<ModelResult & Pick<import('../shared/model.js').AnalysisResult, 'pendingDescriptions'>> {
  const priorIndexes = previous.run.result.indexes;
  const relocated = new Map<string, Promise<Evidence | undefined>>();
  const relocate = (ref: Evidence) => {
    const key = JSON.stringify(ref);
    if (!relocated.has(key))
      relocated.set(
        key,
        (async () => {
          const before = previous.snapshots.find((s) => s.repoId === ref.repoId),
            after = current.find((s) => s.repoId === ref.repoId);
          if (!before || !after) return;
          const method = containingMethod(ref, priorIndexes);
          if (method && !(await sameMethodTree(method, previous, current))) return;
          return remapEvidence(before, after, ref);
        })(),
      );
    return relocated.get(key)!;
  };
  const identity = (item: { evidence: Evidence[] }, catalog: SourceIndex[]) => {
    const refs = item.evidence.length ? item.evidence : evidenceIn(item);
    const method = refs.map((ref) => containingMethod(ref, catalog)).find(Boolean);
    if (method) return methodIdentity(method);
    return JSON.stringify(
      refs.map((ref) => [ref.repoId, ref.side, ref.path, ref.startLine, ref.endLine]),
    );
  };
  const result: ModelResult &
    Pick<import('../shared/model.js').AnalysisResult, 'pendingDescriptions'> = {
    ...delta,
    summary: previous.run.result.summary,
    gaps: [...delta.gaps],
    pendingDescriptions: [...(previous.run.result.pendingDescriptions ?? [])],
  };
  const fixed = new Set(
    delta.followUp?.items.filter((item) => item.status === 'fixed').map((item) => item.previousId),
  );
  for (const section of ['findings', 'scenarios', 'database', 'transactions', 'tests'] as const) {
    if (section === 'tests' && !delta.tests && !previous.run.result.tests) continue;
    const updates = [...(delta[section] ?? [])];
    const items: unknown[] = [];
    for (const prior of previous.run.result[section] ?? []) {
      const key = identity(prior, priorIndexes);
      const candidates = updates.filter((update) => identity(update, indexes) === key);
      // Findings may have multiple distinct remarks in one method; never coalesce them.
      const update =
        updates.find((update) => update.id === prior.id) ??
        (section !== 'findings' && candidates.length === 1 ? candidates[0] : undefined);
      const refs = evidenceIn(prior);
      const mapped = await Promise.all(refs.map(relocate));
      if (section === 'findings' && fixed.has(prior.id)) {
        if (update) updates.splice(updates.indexOf(update), 1);
        continue;
      }
      if (refs.length && mapped.every(Boolean)) {
        const replacements = new Map(refs.map((ref, i) => [JSON.stringify(ref), mapped[i]!]));
        items.push(replaceEvidence(prior, replacements));
      } else if (update) items.push({ ...update, id: prior.id });
      else {
        result.pendingDescriptions!.push({
          id: prior.id,
          title: prior.title,
          summary: prior.summary,
          section,
          revisionId: previous.id,
          evidence: prior.evidence,
        });
        result.gaps.push(
          t(
            '“{0}”: the previous description is kept in the history; no update was received for the changed code.',
            prior.title,
          ),
        );
      }
      if (update) updates.splice(updates.indexOf(update), 1);
    }
    items.push(...updates);
    (result[section] as unknown[]) = items;
    result.pendingDescriptions = result.pendingDescriptions!.filter(
      (p) => p.section !== section || !items.some((item) => (item as { id: string }).id === p.id),
    );
  }
  return result;
}

/** Prior descriptions are needed only for affected source entities, never the whole catalog. */
export async function affectedPrevious(
  previous: ReviewRevision,
  current: Snapshot[],
): Promise<ModelResult> {
  const result: ModelResult = {
    summary: previous.run.result.summary,
    findings: [],
    scenarios: [],
    database: [],
    tests: [],
    transactions: [],
    gaps: [],
  };
  for (const section of ['findings', 'scenarios', 'database', 'tests'] as const) {
    const affected: unknown[] = [];
    for (const item of previous.run.result[section] ?? []) {
      const refs = evidenceIn(item);
      let changed = !refs.length;
      for (const ref of refs) {
        const before = previous.snapshots.find((s) => s.repoId === ref.repoId),
          after = current.find((s) => s.repoId === ref.repoId);
        const method = containingMethod(ref, previous.run.result.indexes);
        if (
          !before ||
          !after ||
          (method
            ? !(await sameMethodTree(method, previous, current))
            : !(await remapEvidence(before, after, ref)))
        ) {
          changed = true;
          break;
        }
      }
      if (changed) affected.push(item);
    }
    (result[section] as unknown[]) = affected;
  }
  result.gaps = [];
  return result;
}

/** Supplemental SQL/test requests retain source-based IDs from earlier analysis rounds. */
export function stableArtifactIds<T extends { id: string; evidence: Evidence[] }>(
  items: T[],
  previous: T[],
  indexes: SourceIndex[],
  priorIndexes: SourceIndex[],
): T[] {
  const key = (item: T, catalog: SourceIndex[]) => {
    const method = evidenceIn(item)
      .map((ref) => containingMethod(ref, catalog))
      .find(Boolean);
    return method ? methodIdentity(method) : undefined;
  };
  return items.map((item) => {
    const identity = key(item, indexes);
    if (!identity) return item;
    const candidates = previous.filter((p) => key(p, priorIndexes) === identity);
    const prior =
      candidates.find((p) => p.id === item.id) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    return prior ? { ...item, id: prior.id } : item;
  });
}
