import type { AnalysisResult, IndexedMethod, Snapshot } from '../shared/model.js';
import type { SqlPreview } from '../shared/sql-preview.js';
import { queryMatchesMethod } from '../shared/sql-coverage.js';

/** Read pinned analysis artifacts. Opening the panel runs no model or renderer. */
export function sqlPreview(
  snapshot: Snapshot,
  method: IndexedMethod,
  result?: AnalysisResult,
): SqlPreview {
  const ref = method.evidence;
  const operations = result?.database.filter((item) => queryMatchesMethod(item, method)) ?? [];
  const variants = operations.map((item) => ({
    title: item.title,
    sql: item.sql,
    parameters: item.query!.parameters,
    unknowns: item.unknowns,
  }));
  const available = variants.filter((item) => item.sql.trim());
  const single = available.length === 1 && variants.length === 1 ? available[0] : undefined;
  return {
    evidence: ref,
    snapshotId: snapshot.id,
    headSha: snapshot.headSha,
    method: method.name,
    framework: operations[0]?.query?.framework ?? 'unknown',
    origin: available.length ? 'model' : 'unavailable',
    sql:
      single?.sql ??
      available
        .map((variant) => `-- ${variant.title.replace(/[\r\n]/g, ' ')}\n${variant.sql}`)
        .join('\n\n'),
    dialect: [...new Set(operations.map((item) => item.dialect))].join(' / ') || 'Не определён',
    parameters: single?.parameters ?? [],
    ...(variants.length > 1 ? { variants } : {}),
    unknowns: [
      ...new Set([
        ...operations.flatMap((item) => item.unknowns),
        ...(available.length
          ? ['SQL восстановлен Codex по коду; фактический запрос приложения не наблюдался.']
          : operations.length
            ? []
            : [
                'SQL для этого метода ещё не сформирован Codex. Запустите дополнение SQL; сохранённый разбор PR останется прежним.',
              ]),
      ]),
    ],
  };
}
