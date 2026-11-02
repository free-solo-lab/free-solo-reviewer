import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { databaseSchema } from '../server/database-schema';
import { databaseServiceId } from '../shared/database-schema';
import type { Snapshot } from '../shared/model';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('separates services in a Maven monorepo before parsing identically named tables and Flyway versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'database-services-'));
  roots.push(root);
  const wb = 'apps/warehouse-manager',
    management = 'apps/ledger-management';
  const initial: Record<string, string> = {
    'pom.xml':
      '<project><artifactId>ledger-project</artifactId><packaging>pom</packaging></project>',
    [`${wb}/pom.xml`]:
      '<project><parent><artifactId>ledger-project</artifactId></parent><artifactId>warehouse-manager</artifactId></project>',
    [`${management}/pom.xml`]: '<project><artifactId>ledger-management</artifactId></project>',
    [`${wb}/src/main/resources/db/migration/V1__init.sql`]:
      'CREATE TABLE items(id bigint PRIMARY KEY, wb_only text);',
    [`${management}/src/main/resources/db/migration/V1__init.sql`]:
      'CREATE TABLE items(id bigint PRIMARY KEY, management_only boolean);',
    'infra/clickhouse/init.sql': 'CREATE TABLE metrics(id bigint);',
  };
  const current = {
    ...initial,
    [`${wb}/src/main/resources/db/migration/V2__update.sql`]:
      'ALTER TABLE items ADD COLUMN payout_id bigint;',
    [`${management}/src/main/resources/db/migration/V2__update.sql`]:
      'ALTER TABLE items ADD COLUMN configuration text;',
    [`${wb}/src/test/resources/sql/V99__test.sql`]: 'CREATE TABLE test_only(id bigint);',
  };
  for (const [side, files] of [
    ['base', initial],
    ['head', current],
  ] as const)
    for (const [path, text] of Object.entries(files)) {
      const dest = join(root, side, path);
      await mkdir(join(dest, '..'), { recursive: true });
      await writeFile(dest, text);
    }
  const snapshot = {
    id: 'snapshot',
    repoId: 'repo',
    repoName: 'ledger-project',
    baseDir: join(root, 'base'),
    headDir: join(root, 'head'),
    headSha: 'head',
    mergeBase: 'base',
    baseFiles: Object.keys(initial),
    headFiles: Object.keys(current),
    files: [],
  } as unknown as Snapshot;
  const result = await databaseSchema(snapshot);
  expect(result.tables).toEqual([]); // No misleading project-wide merged schema.
  expect(result.services?.map((s) => s.serviceName)).toEqual([
    'clickhouse',
    'ledger-management',
    'warehouse-manager',
  ]);
  const wbSchema = result.services!.find((s) => s.serviceName === 'warehouse-manager')!,
    mgSchema = result.services!.find((s) => s.serviceName === 'ledger-management')!;
  expect(wbSchema.tables[0].columns.map((c) => c.name)).toEqual(['id', 'wb_only', 'payout_id']);
  expect(mgSchema.tables[0].columns.map((c) => c.name)).toEqual([
    'id',
    'management_only',
    'configuration',
  ]);
  expect(
    wbSchema.tables[0].evidence.every((e) => e.repoId === 'repo' && e.path.startsWith(wb + '/')),
  ).toBe(true);
  expect(wbSchema.snapshotId).toBe('snapshot');
  expect(wbSchema.repoId).toBe('repo');
  expect(databaseServiceId(wbSchema)).not.toBe(databaseServiceId(mgSchema));
  expect(wbSchema.migrations?.filter((m) => m.change !== 'unchanged').map((m) => m.name)).toEqual([
    'V2__update.sql',
  ]);
  expect(
    result.services!.find((s) => s.serviceName === 'clickhouse')!.tables.map((t) => t.name),
  ).toEqual(['metrics']);
  expect(result.migrations?.some((m) => m.path.includes('/src/test/'))).toBe(false);
});
