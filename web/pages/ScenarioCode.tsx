import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Scenario, Snapshot, SourceIndex } from '../../shared/model';
import { scenarioCodeEntries, type ScenarioCodeEntry } from '../../shared/scenario-code';
import { loadNavigationIndex } from '../sessions';
import { WorkspaceContext, useWorkspace } from '../workspace/state';
import { useSourceViewer } from '../workspace/useSourceViewer';
import { SourcePanel } from '../workspace/SourcePanel';
import styles from './ScenarioCode.module.css';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';

export function ScenarioCode({
  scenario,
  views,
  current = false,
}: {
  scenario: Scenario;
  views: ReactNode;
  current?: boolean;
}) {
  return (
    <section className="overview-workspace" aria-label={t('Scenario code')}>
      <header className="overview-workspace-toolbar">
        <h2>{scenario.title}</h2>
        {views}
      </header>
      <CodeFlow
        entries={(snapshots, indexes) => scenarioCodeEntries(scenario, snapshots, indexes)}
        dependency={scenario}
        current={current}
        loading={t('Loading the scenario code…')}
        empty={t('This PR version has no code changes in the selected scenario.')}
      />
    </section>
  );
}

/**
 * Code fragments of one item, one block per method, with diff, comments and navigation.
 * `current` shows the latest PR version while an older review is open.
 */
export function CodeFlow({
  entries: select,
  dependency,
  current = false,
  loading,
  empty,
}: {
  entries: (snapshots: Snapshot[], indexes: SourceIndex[]) => ScenarioCodeEntry[];
  /** The item the fragments belong to; they are selected again when it changes. */
  dependency: unknown;
  current?: boolean;
  loading: string;
  empty: string;
}) {
  const workspace = useWorkspace();
  const session = current ? workspace.sessionData : workspace.session;
  const [loaded, setLoaded] = useState<{
    version: string;
    indexes: SourceIndex[];
    errors: string[];
  }>();
  const version = session?.snapshots.map((snapshot) => snapshot.id).join(',') ?? '';
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const jobs = session.snapshots.flatMap((snapshot) => [
      loadNavigationIndex(session.id, snapshot.id, 'head'),
      ...(snapshot.files.some((file) => file.removedLines.length > 0)
        ? [loadNavigationIndex(session.id, snapshot.id, 'base')]
        : []),
    ]);
    void Promise.allSettled(jobs).then((results) => {
      if (cancelled) return;
      setLoaded({
        version,
        indexes: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        errors: results.some((result) => result.status === 'rejected')
          ? [t('Part of the local index could not be loaded. Available fragments are shown.')]
          : [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [session?.id, version]);
  const indexes = loaded?.version === version ? loaded.indexes : undefined;
  const entries = useMemo(
    () => (indexes ? select(session?.snapshots ?? [], indexes) : []),
    [dependency, indexes, version],
  );
  return (
    <div className={styles.flow}>
      {!indexes ? (
        <p className={styles.empty}>{loading}</p>
      ) : (
        <>
          {loaded?.errors.map((error) => (
            <p role="alert" className={styles.empty} key={error}>
              {error}
            </p>
          ))}
          {!entries.length && <p className={styles.empty}>{empty}</p>}
          {entries.map((entry, index) => (
            <ScenarioCodeBlock
              key={`${version}:${entry.id}`}
              entry={entry}
              ordinal={index + 1}
              current={current}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ScenarioCodeBlock({
  entry,
  ordinal,
  current,
}: {
  entry: ScenarioCodeEntry;
  ordinal: number;
  current: boolean;
}) {
  const workspace = useWorkspace();
  const [error, setError] = useState('');
  const viewer = useSourceViewer({
    session: current ? workspace.sessionData : workspace.session,
    sessionData: workspace.sessionData,
    reviewVersion: current ? undefined : workspace.reviewVersion,
    liveSession: workspace.liveSession,
    drafts: workspace.drafts,
    tab: workspace.tab,
    setRevisionId: workspace.setRevisionId,
    onFile: () => {},
    task: async (_label, run) => {
      try {
        setError('');
        await run();
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    shared: { fileViews: workspace.fileViews, reviewDiscussion: workspace.reviewDiscussion },
  });
  useEffect(() => {
    void viewer.openSource(entry.evidence).then(() => viewer.setDefinitionPicker(null));
  }, [entry.id, current]);
  // The methods are listed in the code below, so the heading names only the class.
  const className = entry.evidence.path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');
  return (
    <article className={styles.block} aria-label={entry.label}>
      <div className={styles.heading}>
        <span>{ordinal}</span>
        <h3 title={entry.label}>{className}</h3>
        <button
          className="text-button"
          onClick={() => void workspace.openSource(entry.evidence, current ? 'current' : undefined)}
        >
          {t('Whole file')}
        </button>
      </div>
      {error ? (
        <p className={styles.empty} role="alert">
          {error}
        </p>
      ) : !viewer.source ? (
        <p className={styles.empty}>{t('Loading the fragment…')}</p>
      ) : (
        <WorkspaceContext.Provider
          value={{
            ...workspace,
            ...viewer,
            followDefinition: (link) => {
              if (link.targets[0])
                void workspace.openSource(
                  link.targets[0].evidence,
                  current ? 'current' : undefined,
                );
            },
            navigateDefinition: (evidence) =>
              workspace.openSource(evidence, current ? 'current' : undefined),
            addComment: (body, evidence, forCodex) =>
              workspace.addComment(body, evidence, forCodex, viewer.source?.versionId),
          }}
        >
          <div className={styles.source} onKeyDownCapture={viewer.sourceKeyboard}>
            <SourcePanel inline flow ranges={entry.ranges} />
          </div>
        </WorkspaceContext.Provider>
      )}
    </article>
  );
}
