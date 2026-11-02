import { api } from '../api';
import { fetchSession } from '../sessions';
import { OverviewView } from '../Overview';
import { Empty, Gaps } from '../components';
import { FindingCard } from '../workspace/FindingCard';
import { useWorkspace } from '../workspace/state';
import { Icon } from '../icons';
import { plural } from '../ui/plural';
import { Markdown } from '../Markdown';
import { omitSections, reviewDescription } from '../../shared/review-description';
import { ChangesSinceReview } from './ChangesSinceReview';
import { ChangeCards } from './ChangeCards';
import { ScenarioDiagram, hasDiagram } from './ScenarioDiagram';
import styles from './OverviewPage.module.css';
import { ScenarioCode } from './ScenarioCode';
import { inAllLanguages, startsLike, t } from '../../shared/i18n';
import { useEffect } from 'react';
import { useStepSettings } from '../queries';
import { missingScenarios, scenarioRoots } from '../../shared/scenario-coverage';
import { reviewScopeSnapshots } from '../../shared/analysis-scope';

/** An entry method without a diagram is addressed as a scenario with this prefix. */
const ROOT = 'root:';

export function OverviewPage() {
  const {
    sessionData,
    setSession,
    reviewVersion,
    session,
    liveRun,
    service,
    setService,
    scenarioId,
    setScenarioId,
    scenarioView,
    setScenarioView,
    revisionId,
    liveSession,
    selectedSnapshots,
    matches,
    result,
    missingScenarioCount,
    missingScenarioRoots,
    scenarioMenuUpdates,
    showScenarioUpdates,
  } = useWorkspace();
  const diagramsOnRequest = !!useStepSettings().data?.onDemand.includes('scenarios');
  // Once the requested diagram is built, its entry method opens as the new scenario.
  const requestedRoot =
    session && result && scenarioId.startsWith(ROOT)
      ? scenarioRoots(reviewScopeSnapshots(session), result.indexes).find(
          (root) => root.id === scenarioId.slice(ROOT.length),
        )
      : undefined;
  const builtScenario =
    requestedRoot &&
    result?.scenarios.find((scenario) => !missingScenarios([requestedRoot], [scenario]).length);
  useEffect(() => {
    if (builtScenario) setScenarioId(builtScenario.id);
  }, [builtScenario?.id]);
  if (!session) return null;
  // After a re-review the overview is about what changed since then, unless an older version
  // was picked explicitly.
  const followUpMode = !!session.update && (!revisionId || revisionId === 'current');
  const shown = followUpMode && liveRun?.result.followUp ? liveRun.result : result;
  const shownRun = shown === result ? session.run : liveRun;
  // A failure note left by an earlier attempt is obsolete once the analysis has completed.
  const gaps = (shown?.gaps ?? []).filter(
    (gap) => !(shownRun?.state === 'complete' && startsLike(gap, 'Codex/analysis: {0}')),
  );
  if (!shown)
    return followUpMode ? (
      <section className="overview-workspace" aria-label={t('Changes since the review')}>
        <header className="overview-workspace-toolbar">
          <h2>{t('Changes since the review')}</h2>
        </header>
        <div className="overview-workspace-content">
          <ChangesSinceReview />
        </div>
      </section>
    ) : (
      <Empty title={t('The code is pinned. You can start.')}>
        {t('Press “Analyze” to build the views of this PR version.')}
      </Empty>
    );
  const findings = (
    followUpMode ? (liveRun?.result.followUp ? shown.findings : []) : shown.findings
  ).filter((f) => matches(f.evidence));
  return (
    <OverviewView
      key={`${session.id}:${reviewVersion?.id ?? 'current'}:${followUpMode}`}
      summary={shown.summary}
      title={followUpMode ? t('Changes since the review') : undefined}
      intro={followUpMode ? <ChangesSinceReview /> : undefined}
      scenarios={shown.scenarios}
      snapshots={session.snapshots}
      service={service}
      onService={setService}
      changes={scenarioMenuUpdates}
      showingPrevious={!!reviewVersion && shown === result}
      onLatest={showScenarioUpdates}
      selectedId={scenarioId}
      onSelect={setScenarioId}
      view={scenarioView}
      onView={setScenarioView}
      diagram={(scenario, views) => <ScenarioDiagram scenario={scenario} views={views} />}
      code={(scenario, views) => (
        <ScenarioCode
          key={scenario.id}
          scenario={scenario}
          views={views}
          current={shown !== result}
        />
      )}
      hasDiagram={(scenario) => hasDiagram(scenario, result)}
      missingCount={missingScenarioCount}
      onRequest={
        diagramsOnRequest && !reviewVersion
          ? {
              roots: missingScenarioRoots.map((root) => ({
                id: `${ROOT}${root.id}`,
                name: root.name,
                repoId: root.evidence.repoId,
                evidence: root.evidence,
              })),
              onBuild: async (id) => {
                await api(`/sessions/${sessionData!.id}/scenario-analysis`, 'POST', {
                  root: id.slice(ROOT.length),
                });
                const updated = await fetchSession(sessionData!.id);
                if (liveSession.current === updated.id) setSession(updated);
              },
            }
          : undefined
      }
      running={liveRun?.state === 'running'}
      canAnalyze={!reviewVersion}
      onAnalyze={async () => {
        await api(`/sessions/${sessionData!.id}/scenario-analysis`, 'POST', {});
        const updated = await fetchSession(sessionData!.id);
        if (liveSession.current === updated.id) setSession(updated);
      }}
    >
      {!followUpMode && (
        <ul className={styles.services}>
          {selectedSnapshots.map((s) => (
            <li key={s.id} className={styles.service}>
              <Icon name={s.pr ? 'pullRequest' : 'branch'} size={15} />
              <strong>{s.repoName}</strong>
              <span className={styles.meta}>
                {plural(s.files.length, 'changed file', 'changed files')} ·{' '}
                {s.pr ? `PR #${s.pr.number}` : s.local ? t('local changes') : t('context')}
              </span>
              {s.pr && (
                <a
                  className={styles.link}
                  href={s.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('Open PR #{0} on GitHub', s.pr.number)}
                  title={t('Open on GitHub')}
                >
                  <Icon name="externalLink" size={14} />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {!!shown.changes?.some((card) => card.ui) && (
        <ChangeCards
          title={t('What the user will see')}
          cards={shown.changes.filter((card) => card.ui)}
        />
      )}
      {!!shown.changes?.some((card) => !card.ui) && (
        <ChangeCards cards={shown.changes.filter((card) => !card.ui)} />
      )}
      {findings.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>
            {followUpMode ? t('New remarks') : t('Remarks')} <span>{findings.length}</span>
          </h3>
          <div className={styles.findings}>
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        </>
      )}
      <Gaps gaps={gaps} />
      {followUpMode && shown.summary && (
        <details className={styles.description}>
          <summary>{t('Description of the whole PR')}</summary>
          <Markdown>
            {omitSections(reviewDescription(shown.summary), inAllLanguages('Before and after'))}
          </Markdown>
        </details>
      )}
    </OverviewView>
  );
}
