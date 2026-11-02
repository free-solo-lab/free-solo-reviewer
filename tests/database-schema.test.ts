import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { extractDdl, databaseSchema } from '../server/database-schema';
import {
  compareSchemas,
  compareMigrationPaths,
  schemaPositions,
  tableDiffEvidence,
} from '../shared/database-schema';
import { createSnapshot } from '../server/repository';
import { createApp } from '../server/app';
import { fixture } from './fixtures';
import type { ReviewSession, Snapshot } from '../shared/model';
const parse = (text: string) => extractDdl([{ path: 'V1.sql', text }], 'repo', 'head');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('database schema from pinned DDL', () => {
  it('orders Flyway versions numerically and applies repeatable scripts after versioned scripts', () => {
    expect(
      [
        'R__z.sql',
        'V10__index.sql',
        'V1_10__t.sql',
        'V1_2__t.sql',
        'V1__init.sql',
        'R__a.sql',
      ].sort(compareMigrationPaths),
    ).toEqual([
      'V1__init.sql',
      'V1_2__t.sql',
      'V1_10__t.sql',
      'V10__index.sql',
      'R__a.sql',
      'R__z.sql',
    ]);
    const result = extractDdl(
      [
        { path: 'R__index.sql', text: 'CREATE INDEX ix ON item (id);' },
        { path: 'V1__init.sql', text: 'CREATE TABLE item(id int);' },
      ],
      'repo',
      'head',
    );
    expect(result.warnings).toEqual([]);
    expect(result.tables[0].indexes[0].name).toBe('ix');
  });
  it('links data-changing scripts to their targets without treating data as a structural change', () => {
    const initial = 'CREATE TABLE item(id int PRIMARY KEY); CREATE TABLE audit(id int);';
    const before = parse(initial);
    const after = parse(
      `${initial}\n-- UPDATE fake SET id=1;\nINSERT INTO item(id) VALUES (1); UPDATE item SET id=2; DELETE FROM audit; TRUNCATE TABLE item, audit RESTART IDENTITY;`,
    );
    expect(
      after.effects.filter((effect) => effect.kind === 'data').map((effect) => effect.table),
    ).toEqual(['item', 'item', 'audit', 'item', 'audit']);
    expect(
      compareSchemas(before.tables, after.tables).every((table) => table.change === 'unchanged'),
    ).toBe(true);
    expect(after.effects.every((effect) => effect.evidence.path === 'V1.sql')).toBe(true);
  });
  it('keeps added, removed and modified scripts with source links from both sides', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const snapshot = await createSnapshot(
      f.repo,
      12,
      join(f.root, 'migration-snapshots'),
      f.github,
    );
    const path = 'src/main/resources/db/migration/V2__change_data.sql';
    const initial = 'src/main/resources/db/migration/V1__init.sql';
    const removed = 'src/main/resources/db/migration/V3__old_data.sql';
    const repeatable = 'src/main/resources/db/migration/R__new_data.sql';
    for (const side of ['base', 'head'] as const) {
      const dir = side === 'head' ? snapshot.headDir : snapshot.baseDir;
      await import('node:fs/promises').then((fs) =>
        fs.mkdir(join(dir, 'src/main/resources/db/migration'), { recursive: true }),
      );
      await writeFile(
        join(dir, initial),
        'CREATE TABLE orders(id int PRIMARY KEY); CREATE TABLE audit(id int);',
      );
      await writeFile(
        join(dir, path),
        side === 'base' ? 'UPDATE audit SET id=1;' : 'UPDATE orders SET id=2;',
      );
    }
    await writeFile(join(snapshot.baseDir, removed), 'DELETE FROM orders;');
    await writeFile(join(snapshot.headDir, repeatable), 'INSERT INTO audit(id) VALUES(1);');
    snapshot.baseFiles = [initial, path, removed];
    snapshot.headFiles = [initial, path, repeatable];
    const schema = await databaseSchema(snapshot);
    expect(schema.tables.every((table) => table.change === 'unchanged')).toBe(true);
    expect(schema.migrations?.map((m) => [m.name, m.change])).toEqual([
      ['V1__init.sql', 'unchanged'],
      ['V2__change_data.sql', 'modified'],
      ['V3__old_data.sql', 'removed'],
      ['R__new_data.sql', 'added'],
    ]);
    const modified = schema.migrations!.find((m) => m.path === path)!;
    expect(modified.effects.map((effect) => [effect.table, effect.evidence.side])).toEqual([
      ['orders', 'head'],
      ['audit', 'base'],
    ]);
    expect(schema.migrations!.find((m) => m.path === removed)?.evidence.side).toBe('base');
    expect(schema.migrations!.find((m) => m.path === repeatable)?.kind).toBe('repeatable');
  });
  it('extracts columns, composite keys, inline/explicit FKs and partial expression indexes', () => {
    const result = parse(`
      CREATE TABLE public.account (id bigint, kind varchar(32) NOT NULL, PRIMARY KEY (id, kind));
      CREATE TABLE public.invoice (
        id bigint PRIMARY KEY,
        account_id bigint NOT NULL,
        kind varchar(32) DEFAULT 'a; b, -- text',
        parent_id bigint REFERENCES public.invoice(id),
        CONSTRAINT account_fk FOREIGN KEY (account_id, kind) REFERENCES public.account(id, kind),
        CONSTRAINT unique_account UNIQUE (account_id, kind),
        CHECK (kind <> 'x,y')
      );
      CREATE UNIQUE INDEX doc_kind ON public.invoice (lower(kind), id DESC) WHERE kind <> 'a  b';
    `);
    expect(result.warnings).toEqual([]);
    const table = result.tables[1];
    expect(table.columns.map((column) => column.name)).toEqual([
      'id',
      'account_id',
      'kind',
      'parent_id',
    ]);
    expect(table.columns[0]).toMatchObject({ primary: true, nullable: false });
    expect(table.columns[2].definition).toContain("'a; b, -- text'");
    expect(table.foreignKeys).toContainEqual({
      name: 'account_fk',
      columns: ['account_id', 'kind'],
      target: 'public.account',
      targetColumns: ['id', 'kind'],
    });
    expect(table.indexes.find((index) => index.name === 'doc_kind')?.definition).toContain(
      "'a  b'",
    );
    expect(table.ddl).toHaveLength(2);
    expect(table.evidence.every((ref) => ref.side === 'head' && ref.endLine >= ref.startLine)).toBe(
      true,
    );
  });
  it('replays ordered ALTER migrations and marks only changed entities, including removals', () => {
    const initial = `CREATE TABLE parent (id bigint PRIMARY KEY);
      CREATE TABLE item (id bigint PRIMARY KEY, old_name varchar(20), parent_id bigint);
      CREATE INDEX old_idx ON item (old_name);
      CREATE TABLE obsolete (id int);`;
    const before = parse(initial);
    const after = extractDdl(
      [
        {
          path: 'V10.sql',
          text: 'ALTER TABLE item DROP COLUMN old_name; DROP INDEX old_idx; DROP TABLE obsolete;',
        },
        { path: 'V1.sql', text: initial },
        {
          path: 'V2.sql',
          text: 'ALTER TABLE item ADD COLUMN amount numeric(12, 2) DEFAULT 0, ADD CONSTRAINT parent_fk FOREIGN KEY (parent_id) REFERENCES parent(id); ALTER TABLE item ALTER COLUMN amount TYPE numeric(16, 2); ALTER TABLE item ALTER COLUMN amount SET NOT NULL; CREATE INDEX amount_idx ON item (amount);',
        },
      ],
      'repo',
      'head',
    );
    expect(after.warnings).toEqual([]);
    const diff = compareSchemas(before.tables, after.tables);
    expect(diff.find((table) => table.name === 'parent')?.change).toBe('unchanged');
    const item = diff.find((table) => table.name === 'item')!;
    expect(item.change).toBe('modified');
    expect(item.columns.find((column) => column.name === 'amount')).toMatchObject({
      change: 'added',
      type: 'numeric(16, 2)',
      nullable: false,
    });
    expect(item.columns.find((column) => column.name === 'old_name')?.change).toBe('removed');
    expect(item.indexes.find((index) => index.name === 'old_idx')?.change).toBe('removed');
    expect(item.foreignKeys[0].change).toBe('added');
    expect(diff.find((table) => table.name === 'obsolete')?.change).toBe('removed');
    const removed = diff.find((table) => table.name === 'obsolete')!;
    removed.changeEvidence = after.touched
      .filter((item) => item.name === 'obsolete')
      .map((item) => item.evidence);
    expect(
      tableDiffEvidence(removed, {
        files: [{ path: 'V10.sql', status: 'added', patch: '', addedLines: [1], removedLines: [] }],
      } as unknown as Snapshot),
    ).toMatchObject({ side: 'head', path: 'V10.sql' });
    expect(item.beforeDdl?.join('\n')).not.toContain('ADD COLUMN amount');
    expect(item.ddl.join('\n')).toContain('ADD COLUMN amount');
    const layout = schemaPositions(diff);
    expect(layout.positions.get('parent')!.x).toBeLessThan(layout.positions.get('item')!.x);
  });
  it('does not infer links by column names, ignores comments, and reports unsupported DDL', () => {
    const result = parse(`-- CREATE TABLE fake (id int);
      /* CREATE TABLE fake2 (id int); */
      CREATE TABLE audit (invoice_id bigint, note text DEFAULT '/* not a comment */');
      ALTER TABLE audit RENAME COLUMN note TO description;
      DO $$ BEGIN EXECUTE 'CREATE TABLE runtime(id int)'; END $$;`);
    expect(result.tables.map((table) => table.name)).toEqual(['audit']);
    expect(result.tables[0].foreignKeys).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(schemaPositions([]).width).toBeGreaterThan(0);
  });
  it('serves the selected snapshot without invoking Codex or requiring an analysis', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const { app, store } = createApp({
      dataDir: join(f.root, 'schema-app'),
      github: f.github,
      provider: {
        id: 'unused',
        async analyze() {
          throw new Error('must not invoke model');
        },
      },
    });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const request = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const session = (
      await request('POST', '/api/sessions', {
        title: 'Schema',
        repositories: [{ repoId: f.repo.id, prNumber: 12 }],
      })
    ).json<ReviewSession>();
    const snapshot = session.snapshots[0];
    const path = 'src/main/resources/db/migration/V3__sample.sql';
    await writeFile(join(snapshot.headDir, path), 'CREATE TABLE sample (id int PRIMARY KEY);');
    snapshot.headFiles.push(path);
    store.saveSession(session);
    const response = await request(
      'GET',
      `/api/sessions/${session.id}/database-schema?snapshotId=${snapshot.id}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().snapshotId).toBe(snapshot.id);
    expect(response.json().tables).toMatchObject([
      { name: 'sample', change: 'added', columns: [{ name: 'id', primary: true }] },
    ]);
    expect(store.session(session.id)?.run).toBeNull();
    expect(
      (await request('GET', `/api/sessions/${session.id}/database-schema?snapshotId=unknown`))
        .statusCode,
    ).toBe(404);
    expect(f.github.submissions).toEqual([]);
  });
});
