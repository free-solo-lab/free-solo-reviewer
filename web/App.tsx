import type { ReactNode } from 'react';
import { useMatch } from 'react-router';
import { SettingsPage } from './pages/SettingsPage';
import { StatisticsPage } from './pages/StatisticsPage';
import { api } from './api';
import { fetchSession } from './sessions';
import { AnalysisChat } from './AnalysisChat';
import { Setup, SqlQueryDrawer } from './components';
import { WorkspaceContext, useWorkspaceState } from './workspace/state';
import type { Tab } from './workspace/tabs';
import { Sidebar } from './layout/Sidebar';
import { Topbar } from './layout/Topbar';
import { Notices } from './layout/Notices';
import { Toasts } from './layout/Toasts';
import { WelcomePage } from './pages/WelcomePage';
import { ReviewRequestsPage } from './pages/ReviewRequestsPage';
import { AnalysisErrorPanel } from './pages/AnalysisErrorPanel';
import { OverviewPage } from './pages/OverviewPage';
import { ContractsPage } from './pages/ContractsPage';
import { DatabasePage } from './pages/DatabasePage';
import { TestsPage } from './pages/TestsPage';
import { ReviewPage } from './pages/ReviewPage';
import { CommentsPage } from './pages/CommentsPage';
import { FixAttentionToast } from './dialogs/FixAttentionToast';
import { DeleteReviewDialog } from './dialogs/DeleteReviewDialog';
import { SourceDrawer } from './dialogs/SourceDrawer';
import { PublishReviewDialog } from './dialogs/PublishReviewDialog';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { CodeSearch } from './workspace/CodeSearch';
import { useCodeEditsWarning } from './workspace/SourcePanel';
import { useMenuKeys } from './useMenuKeys';
import { useStepSettings } from './queries';
import { t } from '../shared/i18n';
import { reviewSnapshotId } from '../shared/review-timeline';

const pages: Record<Tab, () => ReactNode> = {
  overview: OverviewPage,
  contracts: ContractsPage,
  database: DatabasePage,
  tests: TestsPage,
  review: ReviewPage,
  comments: CommentsPage,
};
/** Pages with their own side menu fill the window instead of scrolling as a document. */
const workspacePages: Partial<Record<Tab, string>> = {
  overview: 'overview-workspace-page',
  contracts: 'contracts-workspace-page',
  database: 'database-workspace-page',
  tests: 'tests-workspace-page',
  review: 'review-workspace-page',
};

export function App() {
  useCodeEditsWarning();
  useMenuKeys();
  const settings = !!useMatch('/settings/*');
  const statistics = !!useMatch('/settings/statistics');
  const requests = !!useMatch('/requests');
  const workspace = useWorkspaceState();
  const {
    session,
    sessionData,
    liveRun,
    tab,
    repos,
    addRepository,
    setup,
    setSetup,
    setError,
    refreshLists,
    openSession,
    fixChatOpen,
    fixAttention,
    deleteTarget,
    sqlTarget,
    setSqlTarget,
    sqlComplete,
    liveSession,
    setSession,
    openSource,
    source,
    preview,
    scenarioView,
  } = workspace;
  const sqlPerMethod = !!useStepSettings().data?.onDemand.includes('sql');
  // The diagram of a range comparison cites its read-only view; SQL belongs to the review itself.
  const sqlSnapshot = sqlTarget && session?.snapshots.find((s) => s.id === sqlTarget.snapshotId);
  const sqlReviewSnapshot = sqlSnapshot ? reviewSnapshotId(sqlSnapshot) : sqlTarget?.snapshotId;
  const Page = pages[tab];
  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className="app-shell">
        <CodeSearch />
        <Sidebar />
        <main
          className={
            settings || requests
              ? 'full-workspace-page'
              : session && workspacePages[tab]
                ? `secondary-menu-page full-workspace-page ${workspacePages[tab]}${tab === 'overview' && scenarioView === 'diagram' ? ' sequence-workspace-page' : ''}`
                : undefined
          }
        >
          {!settings && !requests && <Topbar />}
          <div className="content">
            <Notices />
            {settings ? (
              statistics ? (
                <StatisticsPage />
              ) : (
                <SettingsPage />
              )
            ) : requests ? (
              <ReviewRequestsPage />
            ) : !session ? (
              <WelcomePage />
            ) : (
              <>
                <AnalysisErrorPanel />
                {workspace.comparisonLoading ? (
                  <p role="status">{t('Loading the comparison…')}</p>
                ) : workspace.comparisonError ? (
                  <p role="alert">{workspace.comparisonError.message}</p>
                ) : (
                  <Page />
                )}
              </>
            )}
            <Toasts />
          </div>
          {!settings && !requests && sessionData && (
            <AnalysisChat
              key={sessionData.id}
              sessionId={sessionData.id}
              run={liveRun ?? null}
              snapshots={sessionData.snapshots}
              onUpdate={setSession}
            />
          )}
        </main>
        {!fixChatOpen && fixAttention.length > 0 && <FixAttentionToast />}
        {setup && (
          <Setup
            repos={repos}
            onClose={() => setSetup(false)}
            onError={setError}
            onCreated={async (s) => {
              await refreshLists();
              setSetup(false);
              openSession(
                s.id,
                s.snapshots.some((snapshot) => snapshot.local) ? 'review' : 'overview',
              );
            }}
            onRepo={addRepository}
          />
        )}
        {deleteTarget && <DeleteReviewDialog />}
        {sqlTarget && sessionData && (
          <SqlQueryDrawer
            sessionId={sessionData.id}
            evidence={sqlTarget.evidence}
            snapshotId={sqlTarget.snapshotId}
            analysisKey={`${liveRun?.id}:${liveRun?.state}`}
            analyzing={liveRun?.state === 'running'}
            canGenerate={
              sessionData.snapshots.some((snapshot) => snapshot.id === sqlReviewSnapshot) &&
              !sqlComplete
            }
            perMethod={sqlPerMethod}
            onGenerate={async () => {
              const { repoId, side, path, startLine: line } = sqlTarget.evidence;
              await api(
                `/sessions/${sessionData.id}/sql-analysis`,
                'POST',
                sqlPerMethod ? { method: { repoId, side, path, line } } : {},
              );
              const updated = await fetchSession(sessionData.id);
              if (liveSession.current === sessionData.id) setSession(updated);
            }}
            onClose={() => setSqlTarget(null)}
            onCode={() => {
              setSqlTarget(null);
              void openSource(sqlTarget.evidence, sqlTarget.versionId);
            }}
          />
        )}
        {source && tab !== 'review' && tab !== 'contracts' && <SourceDrawer />}
        {preview && session && <PublishReviewDialog />}
        {workspace.draftDialog && <ReviewDialog />}
      </div>
    </WorkspaceContext.Provider>
  );
}
