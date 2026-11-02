import { parseDocument } from 'yaml';
import { readSource } from './repository.js';
import type { Contract, Snapshot } from '../shared/model.js';
function spec(text: string): Record<string, unknown> | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const data = doc.toJS({ maxAliasCount: 50 }) as Record<string, unknown> | null;
  return data && typeof data === 'object' && ('openapi' in data || 'swagger' in data) ? data : null;
}
function changes(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before) return ['Добавлен контракт'];
  if (!after) return ['Удалён контракт'];
  const result: string[] = [];
  const bp = (before.paths ?? {}) as Record<string, unknown>,
    ap = (after.paths ?? {}) as Record<string, unknown>;
  for (const path of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
    if (!(path in ap)) result.push(`Удалён endpoint ${path} — проверьте совместимость`);
    else if (!(path in bp)) result.push(`Добавлен endpoint ${path}`);
    else if (JSON.stringify(bp[path]) !== JSON.stringify(ap[path]))
      result.push(`Изменён endpoint ${path} — проверьте параметры, ответы и совместимость`);
  }
  if (
    JSON.stringify(before.components ?? before.definitions) !==
    JSON.stringify(after.components ?? after.definitions)
  )
    result.push('Изменены схемы моделей — требуется проверка совместимости');
  return result.length ? result : ['Изменены метаданные или общие настройки контракта'];
}
export async function extractContracts(s: Snapshot): Promise<Contract[]> {
  const result: Contract[] = [];
  for (const file of s.files.filter((f) => /\.(json|ya?ml)$/i.test(f.path))) {
    let before: Record<string, unknown> | null = null,
      after: Record<string, unknown> | null = null;
    try {
      if (s.baseFiles.includes(file.oldPath ?? file.path))
        before = spec(await readSource(s, { side: 'base', path: file.oldPath ?? file.path }));
      if (s.headFiles.includes(file.path))
        after = spec(await readSource(s, { side: 'head', path: file.path }));
      if (!before && !after) continue;
      const side = after ? 'head' : 'base';
      const path = after ? file.path : (file.oldPath ?? file.path);
      result.push({
        id: `contract:${s.repoId}:${file.path}`,
        repoId: s.repoId,
        path: file.path,
        title: String(((after ?? before)?.info as { title?: string })?.title ?? file.path),
        before,
        after,
        reconstructed: false,
        changes: changes(before, after),
        evidence: [{ repoId: s.repoId, side, path, startLine: 1, endLine: 1 }],
      });
    } catch (e) {
      if (/openapi|swagger/i.test(file.path))
        result.push({
          id: `contract:${s.repoId}:${file.path}`,
          repoId: s.repoId,
          path: file.path,
          title: file.path,
          before,
          after,
          reconstructed: false,
          changes: [],
          evidence: [],
          error: String(e),
        });
    }
  }
  return result;
}
