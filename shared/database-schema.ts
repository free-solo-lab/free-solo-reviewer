import type { Evidence, Snapshot } from './model.js';
export type SchemaChange = 'added' | 'removed' | 'modified' | 'unchanged';
export interface SchemaColumn {
  name: string;
  type: string;
  definition: string;
  nullable: boolean;
  primary: boolean;
  change?: SchemaChange;
}
export interface SchemaIndex {
  name: string;
  definition: string;
  unique: boolean;
  primary?: boolean;
  change?: SchemaChange;
}
export interface SchemaForeignKey {
  name: string;
  columns: string[];
  target: string;
  targetColumns: string[];
  change?: SchemaChange;
}
export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  constraints?: string[];
  ddl: string[];
  evidence: Evidence[];
  change?: SchemaChange;
  beforeDdl?: string[];
  beforeEvidence?: Evidence[];
  changeEvidence?: Evidence[];
}
export function tableDiffEvidence(table: SchemaTable, snapshot: Snapshot): Evidence | undefined {
  const refs = [
    ...(table.changeEvidence ?? []),
    ...(table.change === 'removed' ? (table.beforeEvidence ?? table.evidence) : table.evidence),
  ];
  return (
    refs.find((ref) =>
      snapshot.files.some(
        (file) =>
          (ref.side === 'head' ? file.path : (file.oldPath ?? file.path)) === ref.path &&
          (ref.side === 'head' ? file.addedLines : file.removedLines).some(
            (line) => line >= ref.startLine && line <= ref.endLine,
          ),
      ),
    ) ?? refs[0]
  );
}
export interface DatabaseSchema {
  snapshotId: string;
  repoId: string;
  repoName: string;
  headSha: string;
  baseSha: string;
  tables: SchemaTable[];
  warnings: string[];
  migrations?: SchemaMigration[];
}
export interface SchemaMigration {
  path: string;
  name: string;
  kind: 'versioned' | 'repeatable' | 'sql';
  version?: string;
  change: SchemaChange;
  evidence: Evidence;
  effects: { table: string; kind: 'structure' | 'data'; evidence: Evidence }[];
}

/** Flyway applies versioned migrations numerically, then repeatable migrations. */
export function compareMigrationPaths(a: string, b: string): number {
  const version = (path: string) =>
    path
      .split('/')
      .pop()!
      .match(/^V(\d+(?:[._]\d+)*)(?:__|\.sql$)/i)?.[1];
  const av = version(a),
    bv = version(b);
  const repeatable = (path: string) => /(?:^|\/)R__/i.test(path);
  if (av && bv) {
    const aa = av.split(/[._]/).map(BigInt),
      bb = bv.split(/[._]/).map(BigInt);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      const left = aa[i] ?? 0n,
        right = bb[i] ?? 0n;
      if (left !== right) return left < right ? -1 : 1;
    }
  }
  if (repeatable(a) !== repeatable(b)) return repeatable(a) ? 1 : -1;
  return a.localeCompare(b, undefined, { numeric: true });
}
const comparable = (value: unknown) =>
  JSON.stringify(value, (key, item) =>
    ['change', 'ddl', 'evidence', 'beforeDdl', 'beforeEvidence'].includes(key) ? undefined : item,
  );
function diffItems<T extends { name: string; change?: SchemaChange }>(
  before: T[],
  after: T[],
): T[] {
  return [
    ...after.map((item) => ({
      ...item,
      change: (!before.some((old) => old.name === item.name)
        ? 'added'
        : comparable(before.find((old) => old.name === item.name)) === comparable(item)
          ? 'unchanged'
          : 'modified') as SchemaChange,
    })),
    ...before
      .filter((item) => !after.some((next) => next.name === item.name))
      .map((item) => ({ ...item, change: 'removed' as const })),
  ];
}
export function compareSchemas(before: SchemaTable[], after: SchemaTable[]): SchemaTable[] {
  return diffItems(before, after).map((table) => {
    const old = before.find((item) => item.name === table.name);
    const next = after.find((item) => item.name === table.name);
    return {
      ...table,
      beforeDdl: old?.ddl ?? [],
      beforeEvidence: old?.evidence ?? [],
      columns: diffItems(old?.columns ?? [], next?.columns ?? []),
      indexes: diffItems(old?.indexes ?? [], next?.indexes ?? []),
      foreignKeys: diffItems(old?.foreignKeys ?? [], next?.foreignKeys ?? []),
    };
  });
}

/** Place referenced tables to the left. Cycles remain visible without recursive layout. */
export function schemaPositions(tables: SchemaTable[]) {
  const levels = new Map<string, number>();
  const level = (name: string, path = new Set<string>()): number => {
    if (levels.has(name)) return levels.get(name)!;
    if (path.has(name)) return 0;
    const table = tables.find((item) => item.name === name);
    const parents =
      table?.foreignKeys.filter(
        (fk) => fk.target !== name && tables.some((item) => item.name === fk.target),
      ) ?? [];
    const value = parents.length
      ? Math.max(...parents.map((fk) => level(fk.target, new Set([...path, name])))) + 1
      : 0;
    levels.set(name, value);
    return value;
  };
  tables.forEach((table) => level(table.name));
  const componentColumns = new Map<string, number>();
  let offset = 0;
  for (const table of tables) {
    if (componentColumns.has(table.name)) continue;
    const component = new Set<string>();
    const visit = (name: string) => {
      if (component.has(name)) return;
      component.add(name);
      for (const other of tables)
        if (other.name === name) {
          for (const key of other.foreignKeys)
            if (tables.some((item) => item.name === key.target)) visit(key.target);
        } else if (other.foreignKeys.some((key) => key.target === name)) visit(other.name);
    };
    visit(table.name);
    for (const name of component) componentColumns.set(name, offset);
    offset += Math.max(...[...component].map((name) => levels.get(name) ?? 0)) + 1;
  }
  const cursors = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number; height: number }>();
  for (const table of tables) {
    const col = (levels.get(table.name) ?? 0) + (componentColumns.get(table.name) ?? 0),
      y = cursors.get(col) ?? 30;
    const height = 68 + table.columns.length * 30 + 34 + table.indexes.length * 30;
    positions.set(table.name, { x: 30 + col * 470, y, height });
    cursors.set(col, y + height + 80);
  }
  return {
    positions,
    width: Math.max(850, ...[...positions.values()].map((p) => p.x + 380)),
    height: Math.max(340, ...[...positions.values()].map((p) => p.y + p.height + 35)),
  };
}
