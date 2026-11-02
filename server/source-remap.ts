import type {
  Evidence,
  Snapshot,
  ChangedFile,
  IndexedMethod,
  SourceIndex,
} from '../shared/model.js';
import { readSource } from './repository.js';

/** Only relocate exact source, with surrounding context to disambiguate repeated lines. */
export async function remapEvidence(
  before: Snapshot,
  after: Snapshot,
  ref: Evidence,
  changes: ChangedFile[] = after.files,
): Promise<Evidence | undefined> {
  const path = changes.find((f) => f.oldPath === ref.path)?.path ?? ref.path;
  try {
    const [oldText, newText] = await Promise.all([
      readSource(before, ref),
      readSource(after, { ...ref, path }),
    ]);
    if (oldText === newText) return { ...ref, path };
    const old = oldText.split('\n'),
      next = newText.split('\n');
    const start = ref.startLine - 1,
      size = ref.endLine - ref.startLine + 1;
    if (start < 0 || size < 1 || start + size > old.length) return;
    const matches: { at: number; score: number }[] = [];
    for (let at = 0; at + size <= next.length; at++) {
      if (!old.slice(start, start + size).every((line, i) => line === next[at + i])) continue;
      let score = 0;
      for (let n = 1; n <= 4; n++) {
        if (start >= n && at >= n && old[start - n] === next[at - n]) score++;
        if (
          start + size + n <= old.length &&
          at + size + n <= next.length &&
          old[start + size + n - 1] === next[at + size + n - 1]
        )
          score++;
      }
      matches.push({ at, score });
    }
    matches.sort((a, b) => b.score - a.score);
    if (!matches.length || (matches[1] && matches[0].score === matches[1].score)) return;
    return { ...ref, path, startLine: matches[0].at + 1, endLine: matches[0].at + size };
  } catch {
    return;
  }
}
export function containingMethod(ref: Evidence, indexes: SourceIndex[]): IndexedMethod | undefined {
  return indexes
    .flatMap((i) => i.methods)
    .filter(
      (m) =>
        m.evidence.repoId === ref.repoId &&
        m.evidence.side === ref.side &&
        m.evidence.path === ref.path &&
        m.evidence.startLine <= ref.startLine &&
        m.evidence.endLine >= ref.endLine,
    )
    .sort(
      (a, b) =>
        a.evidence.endLine - a.evidence.startLine - (b.evidence.endLine - b.evidence.startLine),
    )[0];
}
export const methodIdentity = (m: IndexedMethod) =>
  JSON.stringify([
    m.evidence.repoId,
    m.evidence.side,
    m.evidence.path,
    m.owner ?? '',
    m.name,
    m.signature.replace(/\s+/g, ' ').trim(),
  ]);
export function evidenceIn(value: unknown): Evidence[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(evidenceIn);
  const record = value as Record<string, unknown>;
  if (
    typeof record.repoId === 'string' &&
    typeof record.path === 'string' &&
    typeof record.startLine === 'number' &&
    typeof record.endLine === 'number' &&
    (record.side === 'base' || record.side === 'head')
  )
    return [record as Evidence];
  return Object.values(record).flatMap(evidenceIn);
}
export function replaceEvidence<T>(value: T, replacements: Map<string, Evidence>): T {
  if (!value || typeof value !== 'object') return value;
  const replacement = replacements.get(JSON.stringify(value));
  if (replacement) return replacement as T;
  if (Array.isArray(value)) return value.map((v) => replaceEvidence(v, replacements)) as T;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, replaceEvidence(v, replacements)]),
  ) as T;
}
