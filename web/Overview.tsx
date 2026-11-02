import { ScenarioDescription } from './ScenarioDescription';
import type { ScenarioChange } from '../shared/scenario-changes';
import React, { useState } from 'react';
import type { Scenario, Snapshot } from '../shared/model';
import { reviewDescription } from '../shared/review-description';
import { Markdown } from './Markdown';
import { ScenariosMenu } from './ScenariosMenu';

export function OverviewView({
  summary,
  scenarios,
  snapshots,
  service,
  onService,
  onDiagram,
  missingCount,
  running,
  canAnalyze,
  onAnalyze,
  children,
  changes,
  showingPrevious,
  onLatest,
  initialSelectedId = '',
}: {
  initialSelectedId?: string;
  changes?: Map<string, ScenarioChange>;
  showingPrevious?: boolean;
  onLatest?: (id: string) => void;
  summary: string;
  scenarios: Scenario[];
  snapshots: Snapshot[];
  service: string;
  onService: (id: string) => void;
  onDiagram: (id: string) => void;
  missingCount: number;
  running: boolean;
  canAnalyze: boolean;
  onAnalyze: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const selected = scenarios.find(
    (s) =>
      s.id === selectedId &&
      (service === 'all' || s.evidence.some((ref) => ref.repoId === service)),
  );
  return (
    <>
      <ScenariosMenu
        scenarios={scenarios}
        changes={changes}
        snapshots={snapshots}
        service={service}
        onService={(id) => {
          onService(id);
          setSelectedId('');
        }}
        selectedId={selected?.id}
        onSelect={setSelectedId}
        overview={{ selected: !selected, onSelect: () => setSelectedId('') }}
        missingCount={missingCount}
        running={running}
        canAnalyze={canAnalyze}
        onAnalyze={onAnalyze}
      />
      <section className="overview-workspace" aria-label={selected?.title ?? 'Что меняется'}>
        <header className="overview-workspace-toolbar">
          <h2>{selected?.title ?? 'Что меняется'}</h2>
          {selected && (
            <button className="text-button" onClick={() => onDiagram(selected.id)}>
              Открыть диаграмму →
            </button>
          )}
        </header>
        <div className="overview-workspace-content" key={selected?.id ?? 'summary'}>
          {selected ? (
            <>
              {showingPrevious && changes?.has(selected.id) && (
                <div className="scenario-revision-note">
                  В этом сценарии есть изменения после прошлого ревью.{' '}
                  <button onClick={() => onLatest?.(selected.id)}>Показать исправления →</button>
                </div>
              )}
              <ScenarioDescription
                summary={selected.summary}
                change={showingPrevious ? undefined : changes?.get(selected.id)}
              />
            </>
          ) : (
            <Markdown>
              {reviewDescription(
                summary ||
                  'Модель ещё не подготовила описание изменений. Извлечённые данные доступны в разделах.',
              )}
            </Markdown>
          )}
          {!selected && children}
        </div>
      </section>
    </>
  );
}
