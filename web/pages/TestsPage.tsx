import { reviewScopeSnapshots } from '../../shared/analysis-scope';
import { api } from '../api';
import { fetchSession } from '../sessions';
import { TestsView } from '../Tests';
import { useWorkspace } from '../workspace/state';
import { testCodeEntries } from '../../shared/scenario-code';
import { CodeFlow } from './ScenarioCode';
import { t } from '../../shared/i18n';

export function TestsPage() {
  const {
    sessionData,
    setSession,
    setRevisionId,
    reviewVersion,
    session,
    liveRun,
    liveSession,
    result,
    openSource,
    testUpdates,
    testsReady,
    scenarioView,
    setScenarioView,
  } = useWorkspace();
  if (!session) return null;
  return (
    <TestsView
      revisionMarks={testUpdates}
      showingPrevious={!!reviewVersion}
      onLatest={() => setRevisionId('current')}
      tests={result?.tests ?? []}
      scenarios={result?.scenarios ?? []}
      indexes={result?.indexes ?? []}
      snapshots={reviewVersion ? session.snapshots : reviewScopeSnapshots(session)}
      ready={testsReady}
      running={liveRun?.state === 'running'}
      canAnalyze={!reviewVersion}
      onAnalyze={async () => {
        await api(`/sessions/${sessionData!.id}/test-analysis`, 'POST', {});
        const updated = await fetchSession(sessionData!.id);
        if (liveSession.current === updated.id) setSession(updated);
      }}
      onSource={(ref) => {
        void openSource(ref);
      }}
      view={scenarioView}
      onView={setScenarioView}
      code={(test) => (
        <CodeFlow
          key={test.id}
          entries={(_snapshots, indexes) => testCodeEntries(test, indexes)}
          dependency={test}
          loading={t('Loading the test code…')}
          empty={t('The test code was not found in the index of this version.')}
        />
      )}
    />
  );
}
