import { useMemo, useState, type ReactNode } from 'react';
import type { AnalysisResult, Scenario } from '../../shared/model';
import { withDatabaseInteractions } from '../../shared/sequence';
import { sequenceView } from '../../shared/sequence-view';
import { transactionRegions } from '../../shared/transactions';
import { ScenarioDescription } from '../ScenarioDescription';
import { Sequence } from '../components';
import { Badge } from '../workspace/Badge';
import { useWorkspace } from '../workspace/state';
import styles from './ScenarioDiagram.module.css';
import { t } from '../../shared/i18n';

/** Whether the diagram would show at least one interaction, not just empty lanes. */
export function hasDiagram(scenario: Scenario, result: AnalysisResult | undefined) {
  if (!result) return scenario.steps.length > 0;
  return (
    sequenceView(withDatabaseInteractions(scenario, result), result.indexes).scenario.steps.length >
    0
  );
}

/** The interaction diagram of one scenario; the overview shows it as a view of the scenario. */
export function ScenarioDiagram({
  scenario: selectedScenario,
  views,
}: {
  scenario: Scenario;
  /** The switch between the description and this diagram. */
  views: ReactNode;
}) {
  const {
    sessionData,
    setSqlTarget,
    reviewVersion,
    session,
    setSource,
    result,
    openSource,
    scenarioUpdates,
    scenarioMenuUpdates,
    showScenarioUpdates,
    repoName,
  } = useWorkspace();
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(new Set());
  const expandedScenario = useMemo(
    () =>
      selectedScenario && result
        ? withDatabaseInteractions(selectedScenario, result)
        : selectedScenario,
    [selectedScenario, result],
  );
  const diagram = useMemo(
    () =>
      expandedScenario
        ? sequenceView(
            expandedScenario,
            result?.indexes ?? [],
            collapsedServices,
            session?.snapshots ?? [],
          )
        : null,
    [expandedScenario, result, collapsedServices, session?.snapshots],
  );
  const scenario = diagram?.scenario;
  const txRegions = useMemo(
    () => (scenario && result ? transactionRegions(scenario, result) : []),
    [scenario, result],
  );
  const allInternalsExpanded =
    !!diagram &&
    diagram.owners
      .filter((id) => (diagram.internalCount.get(id) ?? 0) > 0)
      .every((id) => !collapsedServices.has(id));
  const participantName = (id: string) => {
    const participant = diagram?.participants.find((p) => p.id === id);
    return participant?.kind === 'class' || participant?.kind === 'external'
      ? participant.label
      : participant?.id.startsWith('service:')
        ? participant.label
        : participant?.kind === 'database' && participant.owner.startsWith('service:')
          ? `DB · ${diagram?.participants.find((p) => p.id === participant.owner)?.label ?? participant.label}`
          : repoName(id);
  };
  const toggleService = (id: string) =>
    setCollapsedServices((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (!session || !scenario) return null;
  return (
    <section className={styles.sequenceWorkspace} aria-label={t('Interaction diagram')}>
      <header className={styles.sequenceWorkspaceToolbar}>
        <div className={styles.sequenceWorkspaceTitle}>
          <h2 title={scenario.title}>{scenario.title}</h2>
          <Badge value={scenario.confidence} />
          {!reviewVersion && scenarioMenuUpdates.has(selectedScenario!.id) && (
            <span className={styles.scenarioChangeBadge}>{t('Changes since the last review')}</span>
          )}
        </div>
        {diagram && diagram.owners.some((id) => (diagram.internalCount.get(id) ?? 0) > 0) && (
          <div className={styles.sequenceControls} aria-label={t('Service detail')}>
            <button
              className={styles.sequenceDetailToggle}
              aria-pressed={allInternalsExpanded}
              aria-label={
                allInternalsExpanded
                  ? t('Collapse internal calls of all services')
                  : t('Expand internal calls of all services')
              }
              title={
                allInternalsExpanded
                  ? t('Collapse internal calls of all services')
                  : t('Expand internal calls of all services')
              }
              onClick={() =>
                setCollapsedServices(new Set(allInternalsExpanded ? diagram.owners : []))
              }
            >
              <span className={styles.sequenceToggleTrack} aria-hidden="true">
                <span />
              </span>
              {t('Internal calls')}
            </button>
          </div>
        )}
        {views}
      </header>
      {reviewVersion && scenarioMenuUpdates.has(selectedScenario!.id) && (
        <div className="scenario-revision-note">
          {t('This scenario has changes since the last review.')}{' '}
          <button onClick={() => showScenarioUpdates(selectedScenario!.id)}>
            {t('Show the fixes →')}
          </button>
        </div>
      )}
      <Sequence
        key={scenario.id}
        description={
          <details className={styles.scenarioDescription} key={`${session.id}:${scenario.id}`}>
            <summary>{t('Scenario description')}</summary>
            <ScenarioDescription
              summary={scenario.summary}
              change={reviewVersion ? undefined : scenarioUpdates.get(selectedScenario!.id)}
            />
          </details>
        }
        scenario={scenario}
        revisionChange={reviewVersion ? undefined : scenarioUpdates.get(selectedScenario!.id)}
        revisionFiles={sessionData?.update?.changes}
        onSqlSelect={(evidence) => {
          const snapshot = session.snapshots.find(
            (snapshot) => snapshot.repoId === evidence.repoId,
          );
          if (snapshot) {
            setSource(null);
            setSqlTarget({
              evidence,
              snapshotId: snapshot.id,
              versionId: reviewVersion?.id ?? 'current',
            });
          }
        }}
        indexes={result?.indexes}
        snapshots={session.snapshots}
        transactions={txRegions}
        name={participantName}
        participants={diagram?.participants}
        collapsed={collapsedServices}
        onToggleService={toggleService}
        internalCount={diagram?.internalCount}
        onSelect={(refs) => {
          if (refs[0]) void openSource(refs[0]);
        }}
      />
    </section>
  );
}
