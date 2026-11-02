import { ScenarioDescription } from './ScenarioDescription';
import type { ScenarioChange } from '../shared/scenario-changes';
import type React from 'react';
import type { Scenario, Snapshot } from '../shared/model';
import { omitSections, reviewDescription } from '../shared/review-description';
import { Markdown } from './Markdown';
import { ScenariosMenu } from './ScenariosMenu';
import { ViewSwitch, type ItemView } from './ui/ViewSwitch';
import { t } from '../shared/i18n';
import { useState } from 'react';

export interface DiagramRequests {
  roots: {
    id: string;
    name: string;
    repoId: string;
    evidence?: import('../shared/model').Evidence;
  }[];
  onBuild: (id: string) => Promise<void>;
}

/** The page of an entry method whose diagram has not been built: one button builds it. */
function DiagramRequest({
  name,
  running,
  onBuild,
}: {
  name: string;
  running: boolean;
  onBuild: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [sent, setSent] = useState(false);
  return (
    <section className="overview-workspace" aria-label={name}>
      <header className="overview-workspace-toolbar">
        <h2>{name}</h2>
      </header>
      <div className="overview-workspace-content">
        <p>
          {t(
            'The diagram of this entry method has not been built yet. Codex reads only this method and its calls.',
          )}
        </p>
        <button
          className="primary"
          disabled={running}
          onClick={() => {
            setError('');
            setSent(true);
            void onBuild().catch((cause) => {
              setSent(false);
              setError(cause.message);
            });
          }}
        >
          {running && sent ? t('Building the diagram…') : t('Build the diagram')}
        </button>
        {running && !sent && <p role="status">{t('Wait until the current analysis finishes.')}</p>}
        {error && (
          <p className="alert error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function OverviewView({
  summary,
  scenarios,
  snapshots,
  service,
  onService,
  selectedId,
  onSelect,
  view,
  onView,
  diagram,
  code,
  hasDiagram,
  missingCount,
  onRequest,
  running,
  canAnalyze,
  onAnalyze,
  children,
  changes,
  showingPrevious,
  onLatest,
  title = t('What changes'),
  intro,
}: {
  /** Heading of the summary page, shown while no scenario is selected. */
  title?: string;
  /** Replaces the PR description at the top of the summary page. */
  intro?: React.ReactNode;
  /** The selected scenario lives in the address; empty for the summary page. */
  selectedId: string;
  onSelect: (id: string) => void;
  /** A scenario is shown as its description or as its interaction diagram. */
  view: ItemView;
  onView: (view: ItemView) => void;
  code: (scenario: Scenario, views: React.ReactNode) => React.ReactNode;
  diagram: (scenario: Scenario, views: React.ReactNode) => React.ReactNode;
  /** A scenario without a single drawable step is only described. */
  hasDiagram: (scenario: Scenario) => boolean;
  changes?: Map<string, ScenarioChange>;
  showingPrevious?: boolean;
  onLatest?: (id: string) => void;
  summary: string;
  scenarios: Scenario[];
  snapshots: Snapshot[];
  service: string;
  onService: (id: string) => void;
  missingCount: number;
  /** Diagrams run on request: entry methods without one, each built from its own page. */
  onRequest?: DiagramRequests;
  running: boolean;
  canAnalyze: boolean;
  onAnalyze: () => Promise<void>;
  children: React.ReactNode;
}) {
  const selected = scenarios.find(
    (s) =>
      s.id === selectedId &&
      (service === 'all' || s.evidence.some((ref) => ref.repoId === service)),
  );
  const drawable = !!selected && hasDiagram(selected);
  const requested = !selected
    ? onRequest?.roots.find(
        (root) => root.id === selectedId && (service === 'all' || root.repoId === service),
      )
    : undefined;
  return (
    <>
      {(scenarios.length > 0 || !!onRequest?.roots.length) && (
        <ScenariosMenu
          scenarios={scenarios}
          changes={changes}
          snapshots={snapshots}
          service={service}
          onService={(id) => {
            onService(id);
            onSelect('');
          }}
          selectedId={selected?.id ?? requested?.id}
          onSelect={onSelect}
          roots={onRequest?.roots}
          overview={{ selected: !selected, onSelect: () => onSelect('') }}
          missingCount={missingCount}
          running={running}
          canAnalyze={canAnalyze}
          onAnalyze={onAnalyze}
        />
      )}
      {requested && onRequest ? (
        <DiagramRequest
          key={requested.id}
          name={requested.name}
          running={running}
          onBuild={() => onRequest.onBuild(requested.id)}
        />
      ) : selected && view === 'code' ? (
        code(
          selected,
          <ViewSwitch view={view} onView={onView} label={t('Scenario view')} diagram={drawable} />,
        )
      ) : selected && view === 'diagram' && drawable ? (
        diagram(selected, <ViewSwitch view={view} onView={onView} label={t('Scenario view')} />)
      ) : (
        <section className="overview-workspace" aria-label={selected?.title ?? title}>
          <header className="overview-workspace-toolbar">
            <h2>{selected?.title ?? title}</h2>
            {selected && (
              <ViewSwitch
                view={view}
                onView={onView}
                label={t('Scenario view')}
                diagram={drawable}
              />
            )}
          </header>
          <div className="overview-workspace-content" key={selected?.id ?? 'summary'}>
            {selected ? (
              <>
                {showingPrevious && changes?.has(selected.id) && (
                  <div className="scenario-revision-note">
                    {t('This scenario has changes since the last review.')}{' '}
                    <button onClick={() => onLatest?.(selected.id)}>{t('Show the fixes →')}</button>
                  </div>
                )}
                <ScenarioDescription
                  summary={selected.summary}
                  change={showingPrevious ? undefined : changes?.get(selected.id)}
                />
              </>
            ) : (
              (intro ?? (
                <Markdown>
                  {omitSections(
                    reviewDescription(
                      summary ||
                        t(
                          'The model has not prepared a change description yet. Extracted data is available in the sections.',
                        ),
                    ),
                    [t('Before and after')],
                  )}
                </Markdown>
              ))
            )}
            {!selected && children}
          </div>
        </section>
      )}
    </>
  );
}
