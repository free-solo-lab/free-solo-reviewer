import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Evidence, Snapshot } from '../shared/model';
import {
  schemaPositions,
  tableDiffEvidence,
  type DatabaseSchema,
  type SchemaChange,
} from '../shared/database-schema';
import { api } from './api';
import { DatabaseMigrationsMenu } from './DatabaseMigrationsMenu';

const changes: Record<SchemaChange, string> = {
  added: 'Добавлено',
  removed: 'Удалено',
  modified: 'Изменено',
  unchanged: 'Без изменений',
};
const minZoom = 0.25,
  maxZoom = 2;

export function DatabaseSchemaView({
  sessionId,
  snapshots,
  onSource,
}: {
  sessionId: string;
  snapshots: Snapshot[];
  onSource: (ref: Evidence) => void;
}) {
  const [schemas, setSchemas] = useState<DatabaseSchema[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [repo, setRepo] = useState(''),
    [migrationPath, setMigrationPath] = useState(''),
    [onlyChanged, setOnlyChanged] = useState(false),
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
          setSchemas(data);
          setRepo(data[0]?.repoId ?? '');
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
  const schema = schemas.find((item) => item.repoId === repo) ?? schemas[0];
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
  }, [schema?.snapshotId, migrationPath, onlyChanged, tables.length, loading, error, changeZoom]);
  const menu = (
    <DatabaseMigrationsMenu
      snapshots={snapshots}
      schema={schema}
      selectedPath={migrationPath}
      onRepo={(id) => {
        setRepo(id);
        setMigrationPath('');
      }}
      onSelect={setMigrationPath}
    />
  );
  if (loading)
    return (
      <>
        {menu}
        <div className="database-workspace-state" role="status">
          Строим схему по DDL до и после PR…
        </div>
      </>
    );
  if (error)
    return (
      <>
        {menu}
        <div className="database-workspace-state" role="alert">
          Не удалось построить схему: {error}
        </div>
      </>
    );
  return (
    <>
      {menu}
      <section className="database-workspace" aria-label="Схема базы данных">
        <div className="schema-toolbar">
          <div>
            <strong>{migration?.name ?? schema?.repoName}</strong>
            <span>{tables.length} таблиц</span>
            {migration && <span>{touched.size} связано со скриптом</span>}
          </div>
          {migration && (
            <button className="text-button" onClick={() => onSource(migration.evidence)}>
              Код и ревью скрипта →
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(event) => setOnlyChanged(event.target.checked)}
            />{' '}
            Только изменения PR
          </label>
          {!!tables.length && (
            <div className="schema-zoom-controls" role="group" aria-label="Масштаб схемы">
              <button
                aria-label="Уменьшить схему"
                title="Уменьшить"
                disabled={zoom <= minZoom}
                onClick={() => changeZoom(requestedZoom.current - 0.1)}
              >
                −
              </button>
              <button
                className="schema-zoom-reset"
                aria-label="Сбросить масштаб до 100%"
                title="Сбросить масштаб до 100%"
                onClick={() => changeZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="Увеличить схему"
                title="Увеличить"
                disabled={zoom >= maxZoom}
                onClick={() => changeZoom(requestedZoom.current + 0.1)}
              >
                +
              </button>
              <button
                className="schema-zoom-fit"
                onClick={() => {
                  const element = viewport.current;
                  if (element) {
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
                  }
                }}
              >
                Вместить
              </button>
            </div>
          )}
        </div>
        <div className="schema-legend">
          <span className="added">＋ Добавлено</span>
          <span className="modified">~ Изменено</span>
          <span className="removed">− Удалено</span>
          <span>PK — первичный ключ · FK — внешний ключ · UQ — уникальный индекс</span>
          {migration && <span className="migration">Связано с выбранным скриптом</span>}
        </div>
        {migration && !touched.size && (
          <p className="schema-script-note">
            Таблицы для этого скрипта не сопоставлены. Его SQL доступен в коде и ревью.
          </p>
        )}
        {tables.length ? (
          <div
            className="schema-viewport"
            ref={viewport}
            role="region"
            tabIndex={0}
            aria-label="Схема таблиц. Масштаб: Ctrl или Cmd и колесо мыши"
            key={`${schema?.snapshotId}:${migrationPath}:${onlyChanged}`}
          >
            <div
              className="schema-zoom-stage"
              style={{ width: layout.width * zoom, height: layout.height * zoom }}
            >
              <div
                className="schema-canvas"
                style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
              >
                <svg
                  width={layout.width}
                  height={layout.height}
                  className="schema-relations"
                  aria-label="Внешние ключи"
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
                      aria-label={`Открыть DDL ${table.name}`}
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
                            ? 'Изменение данных'
                            : 'Структура из скрипта'}
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
                                : table.foreignKeys.some((key) => key.columns.includes(column.name))
                                  ? 'FK'
                                  : ''}
                            </span>
                            <strong>{column.name}</strong>
                            <code>{column.type}</code>
                            <small>{column.nullable ? 'NULL' : 'NN'}</small>
                          </span>
                        ))}
                      </span>
                      <span className="schema-index-heading">Индексы · {table.indexes.length}</span>
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
        ) : (
          <div className="database-workspace-state inline-empty">
            {onlyChanged
              ? 'Изменений структуры БД в PR нет.'
              : 'DDL таблиц в доступных SQL-миграциях не найден.'}
          </div>
        )}
        {!!schema?.warnings.length && (
          <details className="schema-warnings">
            <summary>Неполные данные схемы · {schema.warnings.length}</summary>
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
