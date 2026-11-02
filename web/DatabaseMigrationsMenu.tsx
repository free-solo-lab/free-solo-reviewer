import { useState } from 'react';
import type { Snapshot } from '../shared/model';
import { databaseServiceId, type DatabaseSchema } from '../shared/database-schema';
import { t, tc } from '../shared/i18n';

const status = {
  added: tc('migration', 'Added'),
  modified: tc('migration', 'Modified'),
  removed: tc('migration', 'Removed'),
  unchanged: '',
};
export function DatabaseMigrationsMenu({
  snapshots,
  schemas,
  selectedServiceId,
  selectedPath,
  onSelect,
}: {
  snapshots: Snapshot[];
  schemas: DatabaseSchema[];
  selectedServiceId: string;
  selectedPath: string;
  onSelect: (repoId: string, path: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const query = search.trim().toLowerCase();
  // Each service owns its schema and paths: Flyway filenames often repeat across services.
  const available: DatabaseSchema[] = schemas.length
    ? schemas
    : snapshots.map((s) => ({
        snapshotId: s.id,
        repoId: s.repoId,
        repoName: s.repoName,
        headSha: s.headSha,
        baseSha: s.mergeBase,
        tables: [],
        warnings: [],
      }));
  const groups = available
    .map((schema) => {
      const id = databaseServiceId(schema),
        name = schema.serviceName ?? schema.repoName;
      const matchesService = `${name} ${schema.repoName} ${schema.serviceDir ?? ''}`
        .toLowerCase()
        .includes(query);
      const migrations = (schema.migrations ?? []).filter(
        (m) =>
          m.change !== 'unchanged' &&
          (matchesService ||
            `${m.path} ${m.effects.map((e) => e.table).join(' ')}`.toLowerCase().includes(query)),
      );
      return { id, name, schema, migrations, matchesService };
    })
    .filter((group) => group.migrations.length > 0);
  const count = groups.reduce((total, group) => total + group.migrations.length, 0);
  return (
    <aside
      className="secondary-menu database-migrations-menu"
      aria-label={t('Database migrations menu')}
    >
      <div className="tests-menu-heading">
        <h2>{t('Migrations')}</h2>
        <span>{count}</span>
      </div>
      <div className="tests-filter">
        <input
          aria-label={t('Search migrations')}
          placeholder={t('Find a service, script or table…')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <nav className="scenario-menu-list" aria-label={t('SQL scripts')}>
        {groups.map(({ id: repoId, name, schema, migrations }) => {
          const expanded = !!query || !collapsed.has(repoId);
          const active = selectedServiceId === repoId;
          return (
            <section className="database-service-group" key={repoId} aria-label={name}>
              <button
                type="button"
                className="database-service-toggle"
                aria-expanded={expanded}
                aria-controls={`database-service-${repoId}`}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(repoId)) next.delete(repoId);
                    else next.add(repoId);
                    return next;
                  })
                }
              >
                <span className="database-service-chevron" aria-hidden="true">
                  {expanded ? '▾' : '▸'}
                </span>
                <strong
                  title={schema.serviceDir ? `${schema.repoName} · ${schema.serviceDir}` : name}
                >
                  {name}
                </strong>
                <small>{migrations.length}</small>
              </button>
              {expanded && (
                <div className="database-service-items" id={`database-service-${repoId}`}>
                  <button
                    data-menu-item
                    className={active && !selectedPath ? 'active' : ''}
                    aria-current={active && !selectedPath ? 'page' : undefined}
                    onClick={() => onSelect(repoId, '')}
                  >
                    {tc('menu', 'Database schema')}
                  </button>
                  {migrations.map((migration) => {
                    const selected = active && selectedPath === migration.path;
                    return (
                      <button
                        key={migration.path}
                        data-menu-item
                        title={migration.path}
                        className={`migration-menu-item menu-change-item ${selected ? 'active' : ''}`}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => onSelect(repoId, migration.path)}
                      >
                        <span className="migration-menu-meta">
                          <span>
                            {migration.kind === 'repeatable'
                              ? 'Repeatable'
                              : migration.version
                                ? `V${migration.version}`
                                : 'SQL'}
                          </span>
                        </span>
                        <strong>
                          {migration.name
                            .replace(/^(?:V[\d._]+|R)__|\.sql$/gi, '')
                            .replace(/_/g, ' ')}
                        </strong>
                        <small>{migration.name}</small>
                        <span
                          className={`review-revision-dot ${migration.change}`}
                          title={t('{0} in PR', status[migration.change])}
                          aria-label={t('{0} in PR', status[migration.change])}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {!groups.length && <p className="tests-menu-empty">{t('No scripts found')}</p>}
      </nav>
    </aside>
  );
}
