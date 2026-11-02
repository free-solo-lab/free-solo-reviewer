import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { DatabaseMigrationsMenu } from '../web/DatabaseMigrationsMenu';
import type { Snapshot } from '../shared/model';
import type { DatabaseSchema, SchemaMigration } from '../shared/database-schema';

it('shows every service and keeps identically named migrations selected only within their service', () => {
  const path = 'db/migration/V1__init.sql';
  const snapshots = [
    { repoId: 'orders', repoName: 'Orders' },
    { repoId: 'ledger', repoName: 'Billing' },
  ] as Snapshot[];
  const schemas = snapshots.map((snapshot): DatabaseSchema => ({
    snapshotId: `snapshot-${snapshot.repoId}`,
    repoId: snapshot.repoId,
    repoName: snapshot.repoName,
    headSha: 'head',
    baseSha: 'base',
    tables: [],
    warnings: [],
    migrations: [
      {
        path,
        name: 'V1__init.sql',
        kind: 'versioned',
        version: '1',
        change: 'added',
        effects: [],
        evidence: { repoId: snapshot.repoId, side: 'head', path, startLine: 1, endLine: 1 },
      },
      {
        path: 'db/migration/V0__context.sql',
        name: 'V0__context.sql',
        kind: 'versioned',
        version: '0',
        change: 'unchanged',
        effects: [],
        evidence: {
          repoId: snapshot.repoId,
          side: 'head',
          path: 'db/migration/V0__context.sql',
          startLine: 1,
          endLine: 1,
        },
      },
    ] satisfies SchemaMigration[],
  }));
  const markup = renderToStaticMarkup(
    React.createElement(DatabaseMigrationsMenu, {
      snapshots,
      schemas,
      selectedServiceId: 'ledger',
      selectedPath: path,
      onSelect: vi.fn(),
    }),
  );
  const orders = markup.slice(
    markup.indexOf('aria-label="Orders"'),
    markup.indexOf('aria-label="Billing"'),
  );
  const billing = markup.slice(markup.indexOf('aria-label="Billing"'));
  expect(orders).toContain('V1__init.sql');
  expect(billing).toContain('V1__init.sql');
  expect(orders).not.toContain('aria-current="page"');
  expect(billing).toContain('aria-current="page"');
  expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  expect(markup.match(/aria-expanded="true"/g)).toHaveLength(2);
  expect(markup).not.toContain('V0__context.sql');
  expect(markup).not.toContain('<select');
});

it('groups modules of one repository by service instead of showing the project name as their group', () => {
  const snapshots = [{ repoId: 'project', repoName: 'ledger-project' }] as Snapshot[];
  const schemas: DatabaseSchema[] = ['warehouse-manager', 'ledger-management'].map((name) => ({
    snapshotId: 's',
    repoId: 'project',
    repoName: 'ledger-project',
    serviceId: `project:${name}`,
    serviceName: name,
    serviceDir: `apps/${name}`,
    headSha: 'h',
    baseSha: 'b',
    tables: [],
    warnings: [],
    migrations: [
      {
        path: `apps/${name}/V1__init.sql`,
        name: 'V1__init.sql',
        kind: 'versioned',
        change: 'added',
        effects: [],
        evidence: {
          repoId: 'project',
          side: 'head',
          path: `apps/${name}/V1__init.sql`,
          startLine: 1,
          endLine: 1,
        },
      },
    ],
  }));
  schemas.push(
    { ...schemas[0], serviceId: 'project:empty', serviceName: 'empty-service', migrations: [] },
    {
      ...schemas[1],
      serviceId: 'project:unchanged',
      serviceName: 'unchanged-service',
      migrations: schemas[1].migrations!.map((migration) => ({
        ...migration,
        change: 'unchanged',
      })),
    },
  );
  const markup = renderToStaticMarkup(
    React.createElement(DatabaseMigrationsMenu, {
      snapshots,
      schemas,
      selectedServiceId: 'project:warehouse-manager',
      selectedPath: '',
      onSelect: vi.fn(),
    }),
  );
  expect(markup).toContain('aria-label="warehouse-manager"');
  expect(markup).toContain('aria-label="ledger-management"');
  expect(markup).not.toContain('aria-label="ledger-project"');
  expect(markup).not.toContain('empty-service');
  expect(markup).not.toContain('unchanged-service');
  expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
});
