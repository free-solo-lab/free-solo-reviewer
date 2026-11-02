import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ItemView } from '../ui/ViewSwitch';
import { useMatch, useNavigate, useSearchParams } from 'react-router';
import type { Evidence, Repository, ReviewDraft } from '../../shared/model';
import { databaseOwner } from '../../shared/sequence';
import { api } from '../api';
import { fetchSession, loadNavigationIndex } from '../sessions';
import {
  queryClient,
  queryKeys,
  useAppStatus,
  useFixAttention,
  useRepositories,
  useSessionList,
  type SessionList,
} from '../queries';
import { isTab, tabs, type Tab } from './tabs';
import { isTestPath } from '../../shared/test-coverage';
import { useTask } from './useTask';
import { useLiveSession } from './useLiveSession';
import { useDrafts } from './useDrafts';
import { useSourceViewer } from './useSourceViewer';
import { useAnalysisViews } from './useAnalysisViews';
import { t } from '../../shared/i18n';

/** The tabs of the review dialog: comments to publish, Codex steps to run, and what is done. */
export type ReviewView = 'comments' | 'codex' | 'history';
/** Within the browser's index cache, so prefetching never evicts what a page uses. */
const PREFETCH_INDEXES = 4;
/** Runs work once the page has rendered and the browser is idle; returns a cancel. */
function whenIdle(work: () => Promise<void>) {
  const run = () => void work();
  // Safari has no idle callbacks.
  if (typeof (window.requestIdleCallback as unknown) === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 500);
  return () => clearTimeout(handle);
}

/** The review workspace: route, open session, drafts, code viewer and dialogs. */
export function useWorkspaceState() {
  const { busy, error, setError, notice, setNotice, task } = useTask();

  const repositories = useRepositories(),
    sessionList = useSessionList(),
    appStatus = useAppStatus();
  const repos = repositories.data ?? [],
    sessions = sessionList.data ?? [],
    status = appStatus.data ?? null;
  const listError = repositories.error ?? sessionList.error ?? appStatus.error;
  useEffect(() => {
    if (listError) setError(listError.message);
  }, [listError]);
  async function refreshLists() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories }),
    ]);
  }
  function addRepository(repo: Repository) {
    queryClient.setQueryData<Repository[]>(queryKeys.repositories, (old = []) =>
      old.some((item) => item.id === repo.id)
        ? old.map((item) => (item.id === repo.id ? repo : item))
        : [...old, repo],
    );
  }

  // The open review, its page and the selected item live in the address.
  const navigate = useNavigate();
  const route = useMatch('/sessions/:sessionId/:tab?');
  const routeSessionId = route?.params.sessionId;
  const tab: Tab = isTab(route?.params.tab) ? route.params.tab : 'overview';
  const [params] = useSearchParams();
  const revisionId = params.get('version') ?? '',
    comparisonFrom = params.get('from') ?? '',
    scenarioId = params.get('scenario') ?? '',
    contractId = params.get('contract') ?? '',
    contractView = params.get('view') === 'swagger' ? 'swagger' : 'changes',
    scenarioView: ItemView =
      params.get('view') === 'diagram'
        ? 'diagram'
        : params.get('view') === 'code'
          ? 'code'
          : 'description';
  // Read the address at call time: several updates in one handler must not overwrite each other.
  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(name, value);
    else next.delete(name);
    navigate({ search: next.size ? `?${next}` : '' }, { replace: true });
  };
  const setRevisionId = (id: string) => setParam('version', id),
    setScenarioId = (id: string) => setParam('scenario', id),
    setContractId = (id: string) => setParam('contract', id),
    setContractView = (view: 'changes' | 'swagger') =>
      setParam('view', view === 'swagger' ? view : ''),
    setScenarioView = (view: ItemView) => setParam('view', view === 'description' ? '' : view);
  // On start the app opens the review read last, or the newest one; a new review starts from
  // the home page only when there is none yet.
  const startOpened = useRef(false);
  useEffect(() => {
    if (routeSessionId) {
      startOpened.current = true;
      try {
        localStorage.setItem('lastSession', routeSessionId);
      } catch {}
      return;
    }
    if (startOpened.current || !sessionList.data) return;
    startOpened.current = true;
    if (window.location.pathname !== '/' || !sessions.length) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem('lastSession');
    } catch {}
    const target =
      sessions.find((item) => item.id === last) ??
      [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    navigate(`/sessions/${target.id}/overview`, { replace: true });
  }, [routeSessionId, sessionList.data]);
  // Diagrams used to be a page of their own; old links open the same scenario on the overview.
  useEffect(() => {
    if (route?.params.tab !== 'sequence' || !routeSessionId) return;
    const next = new URLSearchParams(window.location.search);
    next.set('view', 'diagram');
    navigate(`/sessions/${routeSessionId}/overview?${next}`, { replace: true });
  }, [route?.params.tab, routeSessionId]);

  const live = useLiveSession(revisionId, setError, () => void refreshLists(), comparisonFrom);
  const { sessionData, setSession, reviewVersion, session, liveRun, result } = live;
  const liveSession = live.liveSession;
  // Code navigation of the reviewed repositories is ready before the first jump to the code.
  const prefetchKey = sessionData?.snapshots.map((snapshot) => snapshot.id).join(',');
  useEffect(() => {
    if (!sessionData) return;
    const id = sessionData.id;
    const targets = sessionData.snapshots
      .flatMap((snapshot) => [
        [snapshot.id, 'head'] as const,
        ...(snapshot.pr || snapshot.local ? [[snapshot.id, 'base'] as const] : []),
      ])
      .slice(0, PREFETCH_INDEXES);
    return whenIdle(async () => {
      for (const [snapshotId, side] of targets)
        await loadNavigationIndex(id, snapshotId, side).catch(() => undefined);
    });
  }, [sessionData?.id, prefetchKey]);
  /** The review version shown stays when switching pages; each page keeps its own selection. */
  const setTab = (next: Tab, search: Record<string, string> = {}) => {
    if (!sessionData) return;
    const address = new URLSearchParams(window.location.search);
    const version = address.get('version'),
      from = address.get('from');
    const query = new URLSearchParams({
      ...(version ? { version } : {}),
      ...(from ? { from } : {}),
      ...search,
    });
    navigate(`/sessions/${sessionData.id}/${next}${query.size ? `?${query}` : ''}`);
  };
  const openSession = (id: string, page: Tab = 'overview') => navigate(`/sessions/${id}/${page}`);

  const fixAttention = useFixAttention();
  const currentFixAttention = fixAttention.find((item) => item.sessionId === sessionData?.id);
  const [setup, setSetup] = useState(false),
    [fixChatOpen, setFixChatOpen] = useState(false),
    [draftDialog, setDraftDialog] = useState(false),
    [reviewView, setReviewView] = useState<ReviewView>('comments'),
    [deleteTarget, setDeleteTarget] = useState<SessionList[number] | null>(null),
    [preview, setPreview] = useState<ReviewDraft | null>(null),
    [sqlTarget, setSqlTarget] = useState<{
      evidence: Evidence;
      snapshotId: string;
      versionId: string;
    } | null>(null);
  const draftState = useDrafts({ sessionData, reviewVersion, liveSession, setError });
  const { drafts, setDrafts, dirty, saveDrafts, updateDraft } = draftState;

  const [service, setService] = useState('all'),
    [reviewRepo, setReviewRepo] = useState(''),
    [file, setFile] = useState('');
  const viewer = useSourceViewer({
    session,
    sessionData,
    reviewVersion,
    liveSession,
    drafts,
    tab,
    task,
    setRevisionId,
    onFile: (snapshotId, path) => {
      setReviewRepo(snapshotId);
      setFile(path);
    },
  });
  const { source, openSource, resetSource } = viewer;
  const selectReviewRange = (from: string) => {
    const next = new URLSearchParams(window.location.search);
    if (from) next.set('from', from);
    else next.delete('from');
    next.set('version', 'current');
    resetSource();
    setPreview(null);
    setFile('');
    navigate({ search: `?${next}` }, { replace: true });
  };
  const changeReviewRange = async (from: string) => {
    if (dirty) await saveDrafts();
    selectReviewRange(from);
  };
  const resetReviewRange = () => selectReviewRange('');
  useEffect(() => setSqlTarget(null), [viewer.sourceVersion]);

  const analysis = useAnalysisViews({
    canonicalSession: sessionData,
    sessionData: live.rangeComparison ? session : sessionData,
    session,
    result,
    liveRun,
  });

  const loadSerial = useRef(0);
  async function load(id: string) {
    const request = ++loadSerial.current;
    const [s, d] = await Promise.all([
      fetchSession(id),
      api<ReviewDraft[]>(`/sessions/${id}/drafts`),
    ]);
    if (request !== loadSerial.current) return;
    setSession(s);
    draftState.resetDrafts(id, d);
    setService('all');
    setReviewRepo(s.snapshots.find((s) => s.pr || s.local)?.id ?? '');
    setFixChatOpen(false);
    setFile('');
    resetSource();
    setDraftDialog(false);
  }
  const afterLoad = useRef<(() => void) | null>(null);
  function closeSession() {
    loadSerial.current++;
    liveSession.current = null;
    setSession(null);
    draftState.clearDrafts();
    resetSource();
    setPreview(null);
  }
  useEffect(() => {
    if (routeSessionId === sessionData?.id) return;
    void task(routeSessionId ? t('Opening the session') : t('Closing the session'), async () => {
      if (dirty) await saveDrafts();
      if (!routeSessionId) return closeSession();
      try {
        await load(routeSessionId);
      } catch (error) {
        navigate('/', { replace: true });
        throw error;
      }
      afterLoad.current?.();
      afterLoad.current = null;
    });
  }, [routeSessionId]);

  const selectedSnapshots =
    session?.snapshots.filter((s) => service === 'all' || s.repoId === service) ?? [];
  const matches = (refs: Evidence[]) => service === 'all' || refs.some((e) => e.repoId === service);
  const repoName = (id: string) => {
    const owner = databaseOwner(id);
    const name =
      session?.snapshots.find((s) => s.repoId === (owner ?? id))?.repoName ?? owner ?? id;
    return owner ? t('DB · {0}', name) : name;
  };
  function draftForEvidence(evidence: Evidence | null, repoId = evidence?.repoId) {
    const snap = sessionData?.snapshots.find((s) => s.repoId === repoId && (s.pr || s.local));
    return (
      drafts.find((d) => d.snapshotId === (snap?.id ?? reviewRepo) && d.state === 'draft') ??
      drafts.find((d) => d.state === 'draft')
    );
  }
  function addComment(
    body: string,
    evidence: Evidence | null,
    forCodex = false,
    versionId?: string,
    /** A comment without lines still belongs to one repository, e.g. a GitHub discussion. */
    origin?: { repoId: string; discussionId?: string },
  ) {
    if (reviewVersion && (versionId ?? source?.versionId) !== 'current') return false;
    const target = draftForEvidence(evidence, origin?.repoId ?? evidence?.repoId);
    if (!target) {
      setError(t('No draft available. Open the current version of the review.'));
      return false;
    }
    updateDraft({
      ...target,
      comments: [
        ...target.comments,
        {
          id: crypto.randomUUID(),
          body,
          evidence,
          selected: !forCodex,
          ...(forCodex && { forCodex }),
          ...(origin?.discussionId && { discussionId: origin.discussionId }),
        },
      ],
    });
    setNotice(
      forCodex
        ? t('The task for Codex was added to the fix plan.')
        : t('The comment was added to the draft and is saved automatically.'),
    );
    setTimeout(() => setNotice(''), 5000);
    return true;
  }
  const currentSnapshot =
    session?.snapshots.find((s) => s.id === reviewRepo || s.reviewSnapshotId === reviewRepo) ??
    session?.snapshots.find((s) => s.pr || s.local) ??
    session?.snapshots[0];
  const currentDraft = (reviewVersion?.drafts ?? drafts).find(
    (d) => d.snapshotId === (currentSnapshot?.reviewSnapshotId ?? currentSnapshot?.id),
  );
  /** Opens the review dialog; switching its repository keeps the tab that was open. */
  const openReview = async (repoId = currentSnapshot?.repoId, view: ReviewView = reviewView) => {
    if (!sessionData) return;
    const id = sessionData.id;
    const snapshot =
      sessionData.snapshots.find((item) => item.repoId === repoId && (item.pr || item.local)) ??
      sessionData.snapshots.find((item) => item.pr || item.local);
    if (!snapshot) return;
    await task(t('Opening the review'), async () => {
      const saved = await saveDrafts();
      let draft = (saved ?? drafts).find((item) => item.snapshotId === snapshot.id);
      if (!draft)
        draft = (await api<ReviewDraft[]>(`/sessions/${id}/drafts`)).find(
          (item) => item.snapshotId === snapshot.id,
        );
      if (draft?.state === 'submitted')
        draft = await api<ReviewDraft>(
          `/sessions/${id}/drafts/${snapshot.id}/continue`,
          'POST',
          {},
        );
      if (!draft || liveSession.current !== id) return;
      const target = draft;
      setDrafts((previous) => [
        ...previous.filter((item) => item.snapshotId !== target.snapshotId),
        target,
      ]);
      setRevisionId('current');
      setReviewRepo(snapshot.id);
      setReviewView(view);
      setDraftDialog(true);
    });
  };
  const selectedPath = file || currentSnapshot?.files[0]?.path || currentSnapshot?.headFiles[0];
  const [codeTarget, setCodeTarget] = useState<Evidence | null>(null);
  const openingCode = useRef(0);
  const goToCode = (evidence: Evidence) => {
    const snapshot = session?.snapshots.find((item) => item.repoId === evidence.repoId);
    if (!snapshot) return;
    setReviewRepo(snapshot.id);
    setFile(evidence.path);
    setCodeTarget(evidence);
    setTab('review');
  };
  useEffect(() => {
    if (
      live.comparisonLoading ||
      live.comparisonError ||
      tab !== 'review' ||
      !session ||
      !currentSnapshot ||
      !selectedPath
    )
      return;
    if (codeTarget) {
      setCodeTarget(null);
      openingCode.current++;
      void openSource(codeTarget).finally(() => openingCode.current--);
      return;
    }
    if (source || openingCode.current) return;
    openingCode.current++;
    void openSource({
      repoId: currentSnapshot.repoId,
      path: selectedPath,
      side: currentSnapshot.headFiles.includes(selectedPath) ? 'head' : 'base',
      startLine: 1,
      endLine: 1,
    }).finally(() => openingCode.current--);
  }, [
    tab,
    session?.id,
    currentSnapshot?.id,
    selectedPath,
    source?.visitId,
    codeTarget,
    live.comparisonLoading,
  ]);
  const showScenarioUpdates = (id: string) => {
    const target =
      [...analysis.scenarioUpdates].find(([, change]) => change.previous?.id === id)?.[0] ??
      (analysis.scenarioUpdates.has(id) ? id : undefined);
    setScenarioId(target ?? id);
    setRevisionId('current');
  };
  // Sections with nothing changed in this review stay out of the menu, unless one is open.
  const changedPaths = session?.snapshots.flatMap((s) => s.files.map((f) => f.path)) ?? [];
  const contracts = live.rangeComparison
    ? live.rangeComparison.contracts
    : reviewVersion
      ? (result?.contracts ?? [])
      : (session?.contracts ?? result?.contracts ?? []);
  const shownTabs = tabs
    .map(([id]) => id)
    .filter(
      (id) =>
        id === tab ||
        (id === 'contracts'
          ? contracts.length > 0
          : id === 'database'
            ? changedPaths.some(
                (path) => /\.sql$/i.test(path) || /(db\/changelog|liquibase|flyway)/i.test(path),
              )
            : id === 'comments'
              ? drafts.some((draft) => draft.comments.length > 0) ||
                !!(sessionData?.threadDiscussion ?? sessionData?.discussion)?.length
              : id === 'tests'
                ? // The test analysis covers JVM tests; frontend tests are only grouped in the tree.
                  changedPaths.some((path) => isTestPath(path) && /\.(java|kt)$/.test(path)) ||
                  !!result?.tests?.length
                : true),
    );
  const canAnalyze = sessionData && liveRun?.state !== 'running' && liveRun?.state !== 'complete';
  const prLabel = session?.snapshots
    .filter((s) => s.pr)
    .map((s) => `PR #${s.pr!.number}`)
    .join(' + ');

  return {
    ...live,
    ...draftState,
    ...viewer,
    ...analysis,
    busy,
    error,
    setError,
    notice,
    setNotice,
    task,
    repos,
    sessions,
    sessionsLoading: sessionList.isPending,
    status,
    refreshLists,
    addRepository,
    navigate,
    revisionId,
    setRevisionId,
    changeReviewRange,
    resetReviewRange,
    tab,
    setTab,
    openSession,
    scenarioId,
    setScenarioId,
    contractId,
    setContractId,
    contractView,
    setContractView,
    scenarioView,
    setScenarioView,
    shownTabs,
    fixAttention,
    currentFixAttention,
    setup,
    setSetup,
    fixChatOpen,
    setFixChatOpen,
    draftDialog,
    setDraftDialog,
    reviewView,
    setReviewView,
    deleteTarget,
    setDeleteTarget,
    preview,
    setPreview,
    sqlTarget,
    setSqlTarget,
    service,
    setService,
    reviewRepo,
    setReviewRepo,
    file,
    setFile,
    load,
    afterLoad,
    closeSession,
    selectedSnapshots,
    matches,
    repoName,
    addComment,
    currentSnapshot,
    currentDraft,
    openReview,
    selectedPath,
    goToCode,
    showScenarioUpdates,
    canAnalyze,
    prLabel,
  };
}
export type Workspace = ReturnType<typeof useWorkspaceState>;
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace() outside WorkspaceContext');
  return workspace;
}
