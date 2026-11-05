import type { DatabaseOperation, IndexedMethod, Snapshot, SourceIndex } from './model.js';
import { isTestPath } from './test-coverage.js';
import { affectedProductionMethods, onHead } from './analysis-scope.js';
import { databaseCall } from './sequence.js';
export const queryMethodName = (name: string) =>
  name
    .replace(/\([\s\S]*$/, '')
    .trim()
    .split('.')
    .at(-1);

export function queryMatchesMethod(item: DatabaseOperation, method: IndexedMethod): boolean {
  const query = item.query,
    ref = method.evidence;
  return (
    !!query &&
    queryMethodName(query.method) === method.name &&
    query.evidence.repoId === ref.repoId &&
    query.evidence.side === ref.side &&
    query.evidence.path === ref.path &&
    query.evidence.startLine >= ref.startLine &&
    query.evidence.endLine <= ref.endLine
  );
}

/** Only indexed production database calls; helpers and test cleanup are not queries. */
export function sqlMethods(snapshots: Snapshot[], indexes: SourceIndex[]): IndexedMethod[] {
  return affectedProductionMethods(snapshots, indexes).filter((method) => {
    const ref = method.evidence;
    const snapshot = snapshots.find((s) => s.repoId === ref.repoId);
    return (
      snapshot &&
      !isTestPath(ref.path) &&
      (ref.side === 'head' || !onHead(snapshot, ref.path)) &&
      (!!method.callSites?.some(databaseCall) ||
        method.calls.some((call) =>
          /\b(?:jdbcTemplate|namedParameterJdbcTemplate|jdbc|entityManager)\.(?:query\w*|update|batchUpdate|execute|createNativeQuery|createQuery)\b/.test(
            call,
          ),
        ) ||
        method.annotations.some((annotation) =>
          /@(?:[\w.]+\.)?(?:Query|Select|Insert|Update|Delete|Modifying)\b/.test(annotation),
        ))
    );
  });
}

export function missingSqlMethods(
  snapshots: Snapshot[],
  indexes: SourceIndex[],
  database: DatabaseOperation[],
): IndexedMethod[] {
  // An explicit unknown with method metadata counts as addressed, and remains visible in the panel.
  return sqlMethods(snapshots, indexes).filter(
    (method) => !database.some((item) => queryMatchesMethod(item, method)),
  );
}
