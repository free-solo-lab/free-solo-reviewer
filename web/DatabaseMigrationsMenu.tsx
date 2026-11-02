import { useState } from 'react';
import type { Snapshot } from '../shared/model';
import type { DatabaseSchema } from '../shared/database-schema';

const status = { added: 'Добавлен', modified: 'Изменён', removed: 'Удалён', unchanged: '' };
export function DatabaseMigrationsMenu({
  snapshots,
  schema,
  selectedPath,
  onRepo,
  onSelect,
}: {
  snapshots: Snapshot[];
  schema?: DatabaseSchema;
  selectedPath: string;
  onRepo: (id: string) => void;
  onSelect: (path: string) => void;
}) {
  const [search, setSearch] = useState('');
  const migrations = (schema?.migrations ?? []).filter((migration) =>
    `${migration.path} ${migration.effects.map((effect) => effect.table).join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <aside
      className="secondary-menu database-migrations-menu"
      aria-label="Меню миграций базы данных"
    >
      <div className="tests-menu-heading">
        <h2>Миграции</h2>
        <span>{migrations.length}</span>
      </div>
      <div className="tests-filter">
        <input
          aria-label="Поиск миграции"
          placeholder="Найти скрипт или таблицу…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {snapshots.length > 1 && (
          <select
            aria-label="Сервис базы данных"
            value={schema?.repoId ?? snapshots[0]?.repoId ?? ''}
            onChange={(event) => onRepo(event.target.value)}
          >
            {snapshots.map((snapshot) => (
              <option key={snapshot.repoId} value={snapshot.repoId}>
                {snapshot.repoName}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav className="scenario-menu-list" aria-label="SQL-скрипты">
        <button
          className={!selectedPath ? 'active' : ''}
          aria-current={!selectedPath ? 'page' : undefined}
          onClick={() => onSelect('')}
        >
          Вся схема
        </button>
        {migrations.map((migration) => (
          <button
            key={migration.path}
            title={migration.path}
            className={`migration-menu-item ${selectedPath === migration.path ? 'active' : ''}`}
            aria-current={selectedPath === migration.path ? 'page' : undefined}
            onClick={() => onSelect(migration.path)}
          >
            <span className="migration-menu-meta">
              <span>
                {migration.kind === 'repeatable'
                  ? 'Repeatable'
                  : migration.version
                    ? `V${migration.version}`
                    : 'SQL'}
              </span>
              {migration.change !== 'unchanged' && (
                <small className={migration.change}>{status[migration.change]}</small>
              )}
            </span>
            <strong>
              {migration.name.replace(/^(?:V[\d._]+|R)__|\.sql$/gi, '').replace(/_/g, ' ')}
            </strong>
            <small>{migration.name}</small>
          </button>
        ))}
        {!migrations.length && (
          <p className="tests-menu-empty">
            {search ? 'Скрипты не найдены' : 'SQL-миграции не найдены'}
          </p>
        )}
      </nav>
    </aside>
  );
}
