import type { DatabaseOperation, IndexedMethod, Snapshot, SourceIndex } from './model.js';
import { isTestPath } from './test-coverage.js';

export function queryMatchesMethod(item: DatabaseOperation, method: IndexedMethod): boolean {
  const query = item.query,
    ref = method.evidence;
  return (
    !!query &&
    query.method.replace(/\(\)$/, '').split('.').at(-1) === method.name &&
    query.evidence.repoId === ref.repoId &&
    query.evidence.side === ref.side &&
    query.evidence.path === ref.path &&
    query.evidence.startLine >= ref.startLine &&
    query.evidence.endLine <= ref.endLine
  );
}

/** Only indexed production database calls; helpers and test cleanup are not queries. */
export function sqlMethods(snapshots: Snapshot[], indexes: SourceIndex[]): IndexedMethod[] {
  return indexes
    .flatMap((index) => index.methods)
    .filter((method) => {
      const ref = method.evidence;
      const snapshot = snapshots.find((s) => s.repoId === ref.repoId);
      return (
        snapshot &&
        !isTestPath(ref.path) &&
        (ref.side === 'head' || !snapshot.headFiles.includes(ref.path)) &&
        !!method.callSites?.some((call) => call.database)
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
