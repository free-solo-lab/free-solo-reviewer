import { useMemo, useState } from 'react';
import type { ScenarioChange } from '../shared/scenario-changes';
import type { Scenario, Snapshot } from '../shared/model';
import { evidenceService, scenarioService } from '../shared/source-service';
import { t, tc } from '../shared/i18n';

export function ScenariosMenu({
  scenarios,
  snapshots,
  selectedId,
  service,
  onService,
  onSelect,
  missingCount,
  roots,
  running,
  canAnalyze,
  onAnalyze,
  overview,
  changes,
}: {
  /** Entry methods without a diagram, listed when diagrams are built on request. */
  roots?: {
    id: string;
    name: string;
    repoId: string;
    evidence?: import('../shared/model').Evidence;
  }[];
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visible = useMemo(
    () =>
      scenarios
        .filter(
          (scenario) =>
            (service === 'all' || scenario.evidence.some((ref) => ref.repoId === service)) &&
            `${scenarioService(snapshots, scenario)?.name ?? ''} ${scenario.title} ${scenario.summary}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => Number(changes?.has(b.id) ?? false) - Number(changes?.has(a.id) ?? false)),
    [scenarios, snapshots, service, search, changes],
  );
  const visibleRoots = (roots ?? []).filter(
    (root) =>
      (service === 'all' || root.repoId === service) &&
      `${root.name} ${evidenceService(snapshots, root.evidence)?.name ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const rootService = (root: NonNullable<typeof roots>[number]) =>
    evidenceService(snapshots, root.evidence);
  return (
    <aside
      className="secondary-menu scenarios-menu"
      aria-label={overview ? t('Overview menu') : t('Interaction scenarios menu')}
    >
      <div className="tests-menu-heading">
        <h2>{overview ? t('Overview') : t('Scenarios')}</h2>
        <span>{visible.length}</span>
      </div>
      <div className="tests-filter">
        <input
          aria-label={t('Search scenarios')}
          placeholder={t('Find a scenario…')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {snapshots.length > 1 && (
          <select
            aria-label={t('Scenario service')}
            value={service}
            onChange={(event) => onService(event.target.value)}
          >
            <option value="all">{t('All services')}</option>
            {snapshots.map((snapshot) => (
              <option key={snapshot.repoId} value={snapshot.repoId}>
                {snapshot.repoName}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav className="scenario-menu-list" aria-label={t('Scenario list')}>
        {overview && (
          <button
            data-menu-item
            className={overview.selected ? 'active' : ''}
            aria-current={overview.selected ? 'page' : undefined}
            onClick={overview.onSelect}
          >
            {t('What changes')}
          </button>
        )}
        {[
          ...new Map([
            ...visible.map((s) => {
              const owner = scenarioService(snapshots, s);
              return [owner?.id ?? 'unknown', owner] as const;
            }),
            ...visibleRoots.map((root) => {
              const owner = rootService(root);
              return [owner?.id ?? 'unknown', owner] as const;
            }),
          ]).entries(),
        ].map(([id, owner]) => (
          <section key={id} className="database-service-group" aria-label={owner?.name}>
            <button
              className="database-service-toggle"
              aria-expanded={!!search || !collapsed.has(id)}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            >
              <span aria-hidden="true">{!search && collapsed.has(id) ? '▸' : '▾'}</span>
              <strong title={owner?.dir}>{owner?.name ?? t('Unknown')}</strong>
              <small>
                {visible.filter((s) => (scenarioService(snapshots, s)?.id ?? 'unknown') === id)
                  .length +
                  visibleRoots.filter((root) => (rootService(root)?.id ?? 'unknown') === id).length}
              </small>
            </button>
            {(!!search || !collapsed.has(id)) && (
              <div className="database-service-items">
                {visible
                  .filter((s) => (scenarioService(snapshots, s)?.id ?? 'unknown') === id)
                  .map((scenario) => (
                    <button
                      key={scenario.id}
                      data-menu-item
                      className={`menu-change-item ${selectedId === scenario.id ? 'active' : ''}`}
                      aria-current={selectedId === scenario.id ? 'page' : undefined}
                      title={scenario.title}
                      onClick={() => onSelect(scenario.id)}
                    >
                      <span>{scenario.title}</span>
                      {changes?.has(scenario.id) && (
                        <span
                          className={`review-revision-dot ${changes.get(scenario.id)!.kind}`}
                          title={t(
                            '{0} scenario(s) since the last review',
                            changes.get(scenario.id)!.kind === 'added'
                              ? t('New')
                              : changes.get(scenario.id)!.kind === 'removed'
                                ? tc('migration', 'Removed')
                                : tc('migration', 'Modified'),
                          )}
                          aria-label={t(
                            '{0} scenario(s) since the last review',
                            changes.get(scenario.id)!.kind === 'added'
                              ? t('New')
                              : changes.get(scenario.id)!.kind === 'removed'
                                ? tc('migration', 'Removed')
                                : tc('migration', 'Modified'),
                          )}
                        />
                      )}
                    </button>
                  ))}
                {roots &&
                  visibleRoots.some((root) => (rootService(root)?.id ?? 'unknown') === id) && (
                    <>
                      <h3 className="scenario-menu-group">{t('Without a diagram')}</h3>
                      {visibleRoots
                        .filter((root) => (rootService(root)?.id ?? 'unknown') === id)
                        .map((root) => (
                          <button
                            key={root.id}
                            data-menu-item
                            className={`menu-change-item pending ${selectedId === root.id ? 'active' : ''}`}
                            aria-current={selectedId === root.id ? 'page' : undefined}
                            title={`${rootService(root)?.name ?? ''} · ${root.name}`}
                            onClick={() => onSelect(root.id)}
                          >
                            <span>{root.name}</span>
                          </button>
                        ))}
                    </>
                  )}
              </div>
            )}
          </section>
        ))}
        {!visible.length && !visibleRoots.length && (
          <p className="tests-menu-empty">
            {search ? t('No scenarios found') : t('No scenarios for the selected services yet')}
          </p>
        )}
      </nav>
      {canAnalyze && !roots && missingCount > 0 && (
        <div className="scenario-coverage-action">
          <small>
            {t('Entry methods not analyzed:')} {missingCount}
          </small>
          <button
            disabled={running}
            onClick={() => {
              setError('');
              void onAnalyze().catch((error) => setError(error.message));
            }}
          >
            {running ? t('Completing scenarios…') : t('Complete scenarios')}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </aside>
  );
}
