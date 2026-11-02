import type { Evidence, ModelResult, ReviewRevision, Snapshot } from '../shared/model.js';
import { readSource } from './repository.js';

/** Reuse a claim only when every referenced source file is byte-for-byte unchanged. */
export async function mergeIncremental(
  previous: ReviewRevision,
  current: Snapshot[],
  delta: ModelResult,
): Promise<ModelResult> {
  const unchanged = new Map<string, Promise<boolean>>();
  const sameSource = (ref: Evidence) => {
    const key = `${ref.repoId}:${ref.side}:${ref.path}`;
    if (!unchanged.has(key))
      unchanged.set(
        key,
        (async () => {
          const before = previous.snapshots.find((s) => s.repoId === ref.repoId);
          const after = current.find((s) => s.repoId === ref.repoId);
          if (!before || !after) return false;
          try {
            return (await readSource(before, ref)) === (await readSource(after, ref));
          } catch {
            return false;
          }
        })(),
      );
    return unchanged.get(key)!;
  };
  const result: ModelResult = {
    ...delta,
    summary: previous.run.result.summary,
    gaps: [...delta.gaps],
  };
  const fixed = new Set(
    delta.followUp?.items.filter((item) => item.status === 'fixed').map((item) => item.previousId),
  );
  for (const section of ['findings', 'scenarios', 'database', 'transactions', 'tests'] as const) {
    if (section === 'tests' && !delta.tests && !previous.run.result.tests) continue;
    const updates = new Map((delta[section] ?? []).map((item) => [item.id, item]));
    const items: (typeof delta)[typeof section] = [];
    for (const prior of previous.run.result[section] ?? []) {
      const update = updates.get(prior.id);
      if (update) {
        (items as unknown[]).push(update);
        updates.delete(prior.id);
        continue;
      }
      if (section === 'findings' && fixed.has(prior.id)) continue;
      const refs = [
        ...prior.evidence,
        ...('query' in prior && prior.query ? [prior.query.evidence] : []),
        ...('steps' in prior ? prior.steps.flatMap((step) => step.evidence) : []),
        ...('method' in prior && 'steps' in prior
          ? prior.steps.flatMap((step) => step.data.flatMap((data) => data.evidence))
          : []),
        ...('operations' in prior
          ? prior.operations.flatMap((operation) => operation.evidence)
          : []),
      ];
      if (refs.length && (await Promise.all(refs.map(sameSource))).every(Boolean))
        (items as unknown[]).push(structuredClone(prior));
      else
        result.gaps.push(
          `«${prior.title}»: прежнее описание сохранено в истории; для изменившегося кода актуализация не получена.`,
        );
    }
    (items as unknown[]).push(...updates.values());
    (result[section] as unknown[]) = items;
  }
  return result;
}
