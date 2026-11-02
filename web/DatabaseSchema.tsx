import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Evidence, Snapshot } from '../shared/model';
import {
  schemaPositions,
  databaseServiceId,
  tableDiffEvidence,
  type DatabaseSchema,
  type SchemaChange,
  type SchemaMigration,
} from '../shared/database-schema';
import { api } from './api';
import { DatabaseMigrationsMenu } from './DatabaseMigrationsMenu';
import { ViewSwitch, type ItemView, type ViewOptions } from './ui/ViewSwitch';
import { plural } from './ui/plural';
import { t } from '../shared/i18n';

const changes: Record<SchemaChange, string> = {
  added: t('Added'),
  removed: t('Removed'),
  modified: t('Modified'),
  unchanged: t('Unchanged'),
};
const minZoom = 0.25,
  maxZoom = 2;
const databaseViews: ViewOptions = [
  ['code', t('Code')],
  ['diagram', t('Model')],
];

export function DatabaseSchemaView({
  sessionId,
  snapshots,
  onSource,
  view,
  onView,
  code,
}: {
  sessionId: string;
  snapshots: Snapshot[];
  onSource: (ref: Evidence) => void;
  /** The SQL of the PR's migrations, or the table model they produce. */
  view: 'code' | 'diagram';
  onView: (view: ItemView) => void;
  code: (migrations: SchemaMigration[]) => ReactNode;
}) {
  const [schemas, setSchemas] = useState<DatabaseSchema[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [repo, setRepo] = useState(''),
    [migrationPath, setMigrationPath] = useState(''),
    [onlyChanged, setOnlyChanged] = useState(true),
    [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const requestedZoom = useRef(1),
    renderedZoom = useRef(1);
  const zoomAnchor = useRef<{ x: number; y: number; pointX: number; pointY: number } | null>(null);
  const changeZoom = useCallback((value: number, point?: { x: number; y: number }) => {
    const next = Math.max(minZoom, Math.min(maxZoom, Math.round(value * 1000) / 1000));
    if (next === requestedZoom.current) return;
    const element = viewport.current;
    if (element) {
      const pointX = point?.x ?? element.clientWidth / 2,
        pointY = point?.y ?? element.clientHeight / 2;
      zoomAnchor.current = {
        x: (element.scrollLeft + pointX) / renderedZoom.current,
        y: (element.scrollTop + pointY) / renderedZoom.current,
        pointX,
        pointY,
      };
    }
    requestedZoom.current = next;
    setZoom(next);
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current,
      anchor = zoomAnchor.current;
    if (element && anchor) {
      element.scrollLeft = anchor.x * zoom - anchor.pointX;
      element.scrollTop = anchor.y * zoom - anchor.pointY;
    }
    renderedZoom.current = zoom;
    zoomAnchor.current = null;
  }, [zoom]);
  const snapshotKey = snapshots.map((snapshot) => snapshot.id).join(',');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setSchemas([]);
    setMigrationPath('');
    requestedZoom.current = 1;
    setZoom(1);
    zoomAnchor.current = null;
    void Promise.all(
      snapshots.map((snapshot) =>
        api<DatabaseSchema>(
          `/sessions/${sessionId}/database-schema?${new URLSearchParams({ snapshotId: snapshot.id })}`,
        ),
      ),
    )
      .then((data) => {
        if (active) {
          const services = data
            .flatMap((schema) => schema.services ?? [schema])
            .filter((schema) => schema.migrations?.some((m) => m.change !== 'unchanged'));
          setSchemas(services);
          setRepo((current) =>
            services.some((item) => databaseServiceId(item) === current)
              ? current
              : services[0]
                ? databaseServiceId(services[0])
                : '',
          );
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, snapshotKey]);
  const schema = schemas.find((item) => databaseServiceId(item) === repo) ?? schemas[0];
  const migration = schema?.migrations?.find((item) => item.path === migrationPath);
  const touched = useMemo(
    () => new Set(migration?.effects.map((effect) => effect.table) ?? []),
    [migration],
  );
  const tables = useMemo(
    () =>
      schema?.tables.filter(
        (table) =>
          !onlyChanged ||
          table.change !== 'unchanged' ||
          (migration?.change !== 'unchanged' && touched.has(table.name)),
      ) ?? [],
    [schema, onlyChanged, migration, touched],
  );
  const layout = useMemo(() => schemaPositions(tables), [tables]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientHeight : 1;
      changeZoom(requestedZoom.current * Math.exp(-event.deltaY * unit * 0.002), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [
    schema?.snapshotId,
    migrationPath,
    onlyChanged,
    tables.length,
    loading,
    error,
    view,
    changeZoom,
  ]);
  const viewportKey = `${schema?.snapshotId}:${schema?.serviceId}:${migrationPath}:${onlyChanged}`;
  /** Scales the whole model into the visible area, never above 100%. */
  const fitToView = () => {
    const element = viewport.current;
    if (!element) return;
    element.scrollLeft = 0;
    element.scrollTop = 0;
    changeZoom(
      Math.min(
        (element.clientWidth - 24) / layout.width,
        (element.clientHeight - 24) / layout.height,
        1,
      ),
      { x: 0, y: 0 },
    );
  };
  // A model opens fitted as a whole; the reader zooms in from there.
  const fitted = useRef('');
  useLayoutEffect(() => {
    if (view !== 'diagram' || !tables.length || fitted.current === viewportKey) return;
    fitted.current = viewportKey;
    fitToView();
  }, [viewportKey, view, tables.length, loading]);
  const menu = (
    <DatabaseMigrationsMenu
      snapshots={snapshots}
      schemas={schemas}
      selectedServiceId={schema ? databaseServiceId(schema) : ''}
      selectedPath={migrationPath}
      onSelect={(id, path) => {
        setRepo(id);
        setMigrationPath(path);
      }}
    />
  );
  if (loading)
    return (
      <>
        {menu}
        <div className="database-workspace-state" role="status">
          {t('Building the schema from DDL before and after the PR…')}
        </div>
      </>
    );
  if (error)
    return (
      <>
        {menu}
        <div className="database-workspace-state" role="alert">
          {t('Could not build the schema:')} {error}
        </div>
      </>
    );
  const views = (
    <ViewSwitch view={view} onView={onView} label={t('Database view')} options={databaseViews} />
  );
  if (view === 'code') {
    // The selected script, otherwise every script the PR adds, changes or removes.
    const scripts = migration
      ? [migration]
      : (schema?.migrations ?? []).filter((item) => item.change !== 'unchanged');
    return (
      <>
        {menu}
        <section className="database-workspace" aria-label={t('SQL migrations')}>
          <div className="schema-toolbar">
            <div>
              <strong>{migration?.name ?? schema?.serviceName ?? schema?.repoName}</strong>
              <span>{plural(scripts.length, 'script', 'scripts')}</span>
            </div>
            {views}
          </div>
          {code(scripts)}
        </section>
      </>
    );
  }
  return (
    <>
      {menu}
      <section className="database-workspace" aria-label={t('Database schema')}>
        <div className="schema-toolbar">
          <div>
            <strong>{migration?.name ?? schema?.serviceName ?? schema?.repoName}</strong>
            <span>
              {tables.length} {t('tables')}
            </span>
            {migration && (
              <span>
                {touched.size} {t('related to the script')}
              </span>
            )}
          </div>
          <label>
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(event) => setOnlyChanged(event.target.checked)}
            />{' '}
            {t('PR changes only')}
          </label>
          {views}
        </div>
        <div className="schema-legend">
          <span className="added">{t('＋ Added')}</span>
          <span className="modified">{t('~ Modified')}</span>
          <span className="removed">{t('− Removed')}</span>
          <span>{t('PK: primary key · FK: foreign key · UQ: unique index')}</span>
          {migration && <span className="migration">{t('Related to the selected script')}</span>}
        </div>
        {migration && !touched.size && (
          <p className="schema-script-note">
            {t('No tables were matched to this script. Its SQL is in the Code view.')}
          </p>
        )}
        {tables.length ? (
          <div className="schema-stage">
            <div
              className="schema-viewport"
              ref={viewport}
              role="region"
              tabIndex={0}
              aria-label={t('Table schema. Zoom: Ctrl or Cmd and the mouse wheel')}
              key={viewportKey}
            >
              <div
                className="schema-zoom-stage"
                style={{ width: layout.width * zoom, height: layout.height * zoom }}
              >
                <div
                  className="schema-canvas"
                  style={{
                    width: layout.width,
                    height: layout.height,
                    transform: `scale(${zoom})`,
                  }}
                >
                  <svg
                    width={layout.width}
                    height={layout.height}
                    className="schema-relations"
                    aria-label={t('Foreign keys')}
                  >
                    <defs>
                      <marker
                        id="schema-fk-arrow"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                      </marker>
                    </defs>
                    {tables.flatMap((table) =>
                      table.foreignKeys.map((key) => {
                        const source = layout.positions.get(table.name),
                          target = layout.positions.get(key.target),
                          targetTable = tables.find((item) => item.name === key.target);
                        if (!source || !target || !targetTable) return null;
                        const leftwards = source.x > target.x,
                          self = table.name === key.target;
                        const x1 = source.x + (leftwards ? 0 : 350),
                          x2 = target.x + (leftwards || self ? 350 : 0);
                        const y1 =
                          source.y +
                          68 +
                          Math.max(
                            0,
                            table.columns.findIndex((column) => column.name === key.columns[0]),
                          ) *
                            30 +
                          15;
                        const y2 =
                          target.y +
                          68 +
                          Math.max(
                            0,
                            targetTable.columns.findIndex(
                              (column) => column.name === key.targetColumns[0],
                            ),
                          ) *
                            30 +
                          15;
                        const middle = self ? x1 + 60 : (x1 + x2) / 2;
                        return (
                          <g
                            key={`${table.name}:${key.name}`}
                            className={`schema-relation ${key.change ?? 'unchanged'}`}
                          >
                            <title>
                              {table.name}({key.columns.join(', ')}) → {key.target}(
                              {key.targetColumns.join(', ')})
                            </title>
                            <path
                              d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`}
                              markerEnd="url(#schema-fk-arrow)"
                            />
                            <text x={x1 + (leftwards ? -14 : 14)} y={y1 - 7}>
                              N
                            </text>
                            <text x={x2 + (leftwards ? 10 : -16)} y={y2 - 7}>
                              1
                            </text>
                          </g>
                        );
                      }),
                    )}
                  </svg>
                  {tables.map((table) => {
                    const point = layout.positions.get(table.name)!;
                    return (
                      <button
                        key={table.name}
                        className={`schema-table ${table.change} ${migration ? (touched.has(table.name) ? 'migration-related' : 'migration-context') : ''}`}
                        style={{ left: point.x, top: point.y, width: 350, height: point.height }}
                        onClick={() => {
                          const snapshot = snapshots.find((item) => item.id === schema?.snapshotId);
                          const ref =
                            migration?.effects.find((effect) => effect.table === table.name)
                              ?.evidence ??
                            (snapshot ? tableDiffEvidence(table, snapshot) : undefined);
                          if (ref) onSource(ref);
                        }}
                        aria-label={t('Open DDL of {0}', table.name)}
                      >
                        <span className="schema-table-heading">
                          <strong>{table.name}</strong>
                          <small>
                            {table.change !== 'unchanged' && changes[table.change ?? 'unchanged']}
                          </small>
                        </span>
                        {migration && touched.has(table.name) && (
                          <span className="schema-migration-badge">
                            {migration.effects.some(
                              (effect) => effect.table === table.name && effect.kind === 'data',
                            )
                              ? t('Data change')
                              : t('Structure from the script')}
                          </span>
                        )}
                        <span className="schema-columns">
                          {table.columns.map((column) => (
                            <span
                              className={`schema-column ${column.change}`}
                              key={column.name}
                              title={`${column.name} ${column.definition}`}
                            >
                              <span className="schema-key">
                                {column.primary
                                  ? 'PK'
                                  : table.foreignKeys.some((key) =>
                                        key.columns.includes(column.name),
                                      )
                                    ? 'FK'
                                    : ''}
                              </span>
                              <strong>{column.name}</strong>
                              <code>{column.type}</code>
                              <small>{column.nullable ? 'NULL' : 'NN'}</small>
                            </span>
                          ))}
                        </span>
                        <span className="schema-index-heading">
                          {t('Indexes ·')} {table.indexes.length}
                        </span>
                        <span>
                          {table.indexes.map((index) => (
                            <span
                              className={`schema-index ${index.change}`}
                              key={index.name}
                              title={`${index.name} · ${index.definition}`}
                            >
                              <b>{index.primary ? 'PK' : index.unique ? 'UQ' : 'IX'}</b>
                              <code>{index.name}</code>
                              <small>{index.definition}</small>
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="schema-zoom-controls" role="group" aria-label={t('Schema zoom')}>
              <button
                aria-label={t('Zoom out of the schema')}
                title={t('Zoom out')}
                disabled={zoom <= minZoom}
                onClick={() => changeZoom(requestedZoom.current - 0.1)}
              >
                −
              </button>
              <button
                className="schema-zoom-reset"
                aria-label={t('Reset zoom to 100%')}
                title={t('Reset zoom to 100%')}
                onClick={() => changeZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label={t('Zoom in on the schema')}
                title={t('Zoom in')}
                disabled={zoom >= maxZoom}
                onClick={() => changeZoom(requestedZoom.current + 0.1)}
              >
                +
              </button>
              <button className="schema-zoom-fit" onClick={fitToView}>
                {t('Fit')}
              </button>
            </div>
          </div>
        ) : (
          <div className="database-workspace-state inline-empty">
            {onlyChanged && schema?.tables.length ? (
              <>
                {t('The PR does not change the database structure.')}{' '}
                <button className="text-button" onClick={() => setOnlyChanged(false)}>
                  {t('Show the whole schema')}
                </button>
              </>
            ) : (
              t('No table DDL was found in the available SQL migrations.')
            )}
          </div>
        )}
        {!!schema?.warnings.length && (
          <details className="schema-warnings">
            <summary>
              {t('Incomplete schema data ·')} {schema.warnings.length}
            </summary>
            <ul>
              {schema.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}
