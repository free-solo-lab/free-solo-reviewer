import { useMemo, useState } from 'react';
import type { ScenarioChange } from '../shared/scenario-changes';
import type { Scenario, Snapshot } from '../shared/model';

export function ScenariosMenu({
  scenarios,
  snapshots,
  selectedId,
  service,
  onService,
  onSelect,
  missingCount,
  running,
  canAnalyze,
  onAnalyze,
  overview,
  changes,
}: {
  changes?: Map<string, ScenarioChange>;
  scenarios: Scenario[];
  snapshots: Snapshot[];
  selectedId?: string;
  service: string;
  onService: (id: string) => void;
  onSelect: (id: string) => void;
  missingCount: number;
  running: boolean;
  canAnalyze: boolean;
  onAnalyze: () => Promise<void>;
  overview?: { selected: boolean; onSelect: () => void };
}) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const visible = useMemo(
    () =>
      scenarios.filter(
        (scenario) =>
          (service === 'all' || scenario.evidence.some((ref) => ref.repoId === service)) &&
          `${scenario.title} ${scenario.summary}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [scenarios, service, search],
  );
  return (
    <aside
      className="secondary-menu scenarios-menu"
      aria-label={overview ? 'Меню обзора' : 'Меню сценариев взаимодействия'}
    >
      <div className="tests-menu-heading">
        <h2>{overview ? 'Обзор' : 'Сценарии'}</h2>
        <span>{visible.length}</span>
      </div>
      <div className="tests-filter">
        <input
          aria-label="Поиск сценария"
          placeholder="Найти сценарий…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {snapshots.length > 1 && (
          <select
            aria-label="Сервис сценария"
            value={service}
            onChange={(event) => onService(event.target.value)}
          >
            <option value="all">Все сервисы</option>
            {snapshots.map((snapshot) => (
              <option key={snapshot.repoId} value={snapshot.repoId}>
                {snapshot.repoName}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav className="scenario-menu-list" aria-label="Список сценариев">
        {overview && (
          <button
            className={overview.selected ? 'active' : ''}
            aria-current={overview.selected ? 'page' : undefined}
            onClick={overview.onSelect}
          >
            Что меняется
          </button>
        )}
        {visible.map((scenario) => (
          <button
            key={scenario.id}
            className={selectedId === scenario.id ? 'active' : ''}
            aria-current={selectedId === scenario.id ? 'page' : undefined}
            onClick={() => onSelect(scenario.id)}
          >
            <span>{scenario.title}</span>
            {changes?.has(scenario.id) && (
              <small className="scenario-change-badge">
                {changes.get(scenario.id)!.kind === 'added' ? 'Новый' : 'Изменён'}
              </small>
            )}
          </button>
        ))}
        {!visible.length && (
          <p className="tests-menu-empty">
            {search ? 'Сценарии не найдены' : 'Для выбранных сервисов сценариев пока нет'}
          </p>
        )}
      </nav>
      {canAnalyze && missingCount > 0 && (
        <div className="scenario-coverage-action">
          <small>Не разобрано входных методов: {missingCount}</small>
          <button
            disabled={running}
            onClick={() => {
              setError('');
              void onAnalyze().catch((error) => setError(error.message));
            }}
          >
            {running ? 'Дополняем сценарии…' : 'Дополнить сценарии'}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </aside>
  );
}
