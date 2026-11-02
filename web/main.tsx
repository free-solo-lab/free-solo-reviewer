import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Repository,
  ReviewSession,
  ReviewDraft,
  Evidence,
  Finding,
  Confidence,
  Snapshot,
} from '../shared/model';
import { withDatabaseInteractions, databaseOwner } from '../shared/sequence';
import { sequenceView } from '../shared/sequence-view';
import { methodLinks, needsDefinitionPicker, type MethodLink } from '../shared/code-navigation';
import { transactionRegions } from '../shared/transactions';
import { api } from './api';
import { displayedRevision, hasRefreshChanges } from '../shared/review-display';
import { Markdown } from './Markdown';
import { DatabaseSchemaView } from './DatabaseSchema';
import { TestsView } from './Tests';
import { ScenariosMenu } from './ScenariosMenu';
import { OverviewView } from './Overview';
import { scenarioRoots, missingScenarios } from '../shared/scenario-coverage';
import { missingSqlMethods } from '../shared/sql-coverage';
import { missingTestMethods } from '../shared/test-coverage';
import { ChangedFilesMenu } from './ChangedFilesMenu';
import { scenarioChanges, scenarioStepMeaning } from '../shared/scenario-changes';
import { ScenarioDescription } from './ScenarioDescription';
import { useReviewDiscussion } from './useReviewDiscussion';
import { sourceDiscussions } from '../shared/discussion-threads';
import { reviewDiffRows } from '../shared/source-diff';
import type { CodeComparison } from '../shared/code-comparison';
import { useViewedMethods } from './useViewedMethods';
import { useViewedFiles } from './useViewedFiles';
import { cacheDrafts, clearDraftCache, restoreDrafts, DraftSaveQueue } from './draft-cache';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/cyrillic-400.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/cyrillic-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/cyrillic-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';
import {
  Empty,
  Gaps,
  commentLocation,
  Sequence,
  SqlQueryDrawer,
  Diff,
  SourceCode,
  ContractViewer,
  Setup,
} from './components';

type SessionList = {
  id: string;
  title: string;
  createdAt: string;
  state: string;
  services: number;
}[];
const tabs = [
  ['overview', 'Обзор'],
  ['sequence', 'Взаимодействия'],
  ['contracts', 'Контракты'],
  ['database', 'База данных'],
  ['tests', 'Тесты'],
  ['review', 'Код и ревью'],
] as const;
type Tab = (typeof tabs)[number][0];
const svgIcon = (children: React.ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
const navIcons: Record<Tab, React.ReactNode> = {
  tests: svgIcon(
    <>
      <path d="m8 3 8 0M10 3v7l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3" />
      <path d="M8 15h8" />
    </>,
  ),
  overview: svgIcon(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>,
  ),
  sequence: svgIcon(
    <>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>,
  ),
  contracts: svgIcon(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </>,
  ),
  database: svgIcon(
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </>,
  ),
  review: svgIcon(
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>,
  ),
};
const states: Record<string, string> = {
  ready: 'Готов к анализу',
  running: 'Анализируется',
  complete: 'Анализ готов',
  partial: 'Частичный анализ',
  failed: 'Прерван',
  cancelled: 'Отменён',
};
const confidence: Record<Confidence, string> = {
  extracted: 'Извлечено из кода',
  inferred: 'Предположение модели',
  unknown: 'Не определено',
};
const severity: Record<string, string> = {
  high: 'Высокий риск',
  medium: 'Требует внимания',
  low: 'Низкий риск',
  info: 'Информация',
};
function Badge({ value }: { value: Confidence }) {
  return <span className={`badge ${value}`}>{confidence[value]}</span>;
}
type SourcePage = {
  comparison?: CodeComparison;
  versionId?: string;
  selection?: Evidence;
  evidence: Evidence;
  text: string;
  visitId: number;
  position?: { top: number; left: number };
};
type SourceVisit = { page: SourcePage; comment: string; position: { top: number; left: number } };
function App() {
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(new Set());
  const [sourceComparisonId, setSourceComparisonId] = useState('');
  const [repos, setRepos] = useState<Repository[]>([]),
    [sessions, setSessions] = useState<SessionList>([]),
    [sessionData, setSession] = useState<ReviewSession | null>(null);
  const [revisionId, setRevisionId] = useState('');
  const [sqlTarget, setSqlTarget] = useState<{
    evidence: Evidence;
    snapshotId: string;
    versionId: string;
  } | null>(null);
  const [draftDialog, setDraftDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionList[number] | null>(null);
  const reviewVersion = displayedRevision(sessionData, revisionId);
  const session =
    sessionData && reviewVersion
      ? { ...sessionData, snapshots: reviewVersion.snapshots, run: reviewVersion.run }
      : sessionData;
  const liveRun = sessionData?.run;
  const [tab, setTab] = useState<Tab>('overview'),
    [service, setService] = useState('all'),
    [drafts, setDrafts] = useState<ReviewDraft[]>([]),
    [dirty, setDirty] = useState(false);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftRevision = useRef(0);
  const draftSaveQueue = useRef(new DraftSaveQueue());
  const [status, setStatus] = useState<{
    login: string | null;
    githubError: string | null;
    codex: string | null;
    demo?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [setup, setSetup] = useState(false);
  const [source, setSource] = useState<SourcePage | null>(null),
    [comment, setComment] = useState(''),
    [preview, setPreview] = useState<ReviewDraft | null>(null);
  const [sourceNavigation, setSourceNavigation] = useState<{
    back: SourceVisit[];
    forward: SourceVisit[];
  }>({ back: [], forward: [] });
  const [definitionPicker, setDefinitionPicker] = useState<MethodLink | null>(null);
  useEffect(() => {
    if (!draftDialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDraftDialog(false);
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [draftDialog]);
  useEffect(() => {
    if (!deleteTarget) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setDeleteTarget(null);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [deleteTarget, busy]);
  const previousCodeTab = useRef(tab);
  useEffect(() => {
    if (previousCodeTab.current === 'review' && tab !== 'review') setSource(null);
    previousCodeTab.current = tab;
  }, [tab]);
  const sourceViewport = useRef<HTMLDivElement | null>(null);
  const sourceSerial = useRef(0);
  const sourceRequest = useRef(0);
  const sourceRestore = useRef<{ version: string; page: SourcePage } | null>(null);
  const activeSource = useRef(source);
  activeSource.current = source;
  const sourceComment = useRef(comment);
  sourceComment.current = comment;
  const [reviewRepo, setReviewRepo] = useState(''),
    [file, setFile] = useState(''),
    [scenarioId, setScenarioId] = useState(''),
    [contractId, setContractId] = useState('');
  const liveSession = useRef<string | null>(null);
  liveSession.current = session?.id ?? null;
  const sourceVersion = session?.snapshots.map((snapshot) => snapshot.id).join(',') ?? '';
  const liveSourceVersion = useRef(sourceVersion);
  liveSourceVersion.current = sourceVersion;
  useEffect(() => {
    setSource(sourceRestore.current?.version === sourceVersion ? sourceRestore.current.page : null);
    sourceRestore.current = null;
    setSqlTarget(null);
    setSourceNavigation({ back: [], forward: [] });
    setDefinitionPicker(null);
  }, [sourceVersion]);
  const [analysisToast, setAnalysisToast] = useState<{ runId: string; text: string } | null>(null);
  const previousAnalysis = useRef<{
    sessionId: string;
    runId: string;
    state: string;
  } | null>(null);
  useEffect(() => {
    const previous = previousAnalysis.current;
    const run = liveRun;
    if (previous?.sessionId !== session?.id) setAnalysisToast(null);
    if (
      session &&
      run &&
      previous?.sessionId === session.id &&
      previous.runId === run.id &&
      previous.state === 'running' &&
      run.state !== 'running'
    ) {
      const text = {
        complete: 'Анализ завершён. Результаты готовы.',
        partial: 'Анализ завершён частично. Доступные результаты сохранены.',
        failed: 'Не удалось завершить анализ. Подробности — в журнале анализа.',
        cancelled: 'Анализ остановлен.',
      }[run.state];
      setAnalysisToast({ runId: run.id, text });
    }
    previousAnalysis.current =
      session && run ? { sessionId: session.id, runId: run.id, state: run.state } : null;
  }, [sessionData?.id, liveRun?.id, liveRun?.state]);
  useEffect(() => {
    if (!analysisToast) return;
    const timer = window.setTimeout(() => setAnalysisToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [analysisToast]);
  async function refreshLists() {
    const [r, s] = await Promise.all([
      api<Repository[]>('/repositories'),
      api<SessionList>('/sessions'),
    ]);
    setRepos(r);
    setSessions(s);
  }
  useEffect(() => {
    void refreshLists().catch((e) => setError(e.message));
    void api<NonNullable<typeof status>>('/status')
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);
  async function load(id: string) {
    const [s, d] = await Promise.all([
      api<ReviewSession>(`/sessions/${id}`),
      api<ReviewDraft[]>(`/sessions/${id}/drafts`),
    ]);
    setSession(s);
    setRevisionId('');
    const restored = restoreDrafts(id, d);
    draftRevision.current++;
    draftsRef.current = restored.drafts;
    setDrafts(restored.drafts);
    setDirty(restored.recovered);
    setService('all');
    setReviewRepo(s.snapshots.find((s) => s.pr)?.id ?? '');
    setFile('');
    setSource(null);
    setSourceComparisonId('');
    setDraftDialog(false);
    setScenarioId('');
    setContractId('');
  }
  useEffect(() => {
    if (!sessionData || liveRun?.state !== 'running') return;
    const id = sessionData.id,
      stream = new EventSource(`/api/sessions/${id}/events`);
    stream.onopen = stream.onmessage = () => {
      void api<ReviewSession>(`/sessions/${id}`)
        .then((s) => {
          if (liveSession.current === id) setSession(s);
          if (s.run?.state !== 'running') {
            stream.close();
            void refreshLists();
          }
        })
        .catch((e) => setError(e.message));
    };
    return () => stream.close();
  }, [sessionData?.id, liveRun?.id, liveRun?.state]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);
  useEffect(() => {
    if (!dirty || !sessionData) return;
    const timer = window.setTimeout(() => {
      void saveDrafts().catch((error) =>
        setError(`Не удалось сохранить черновик: ${error.message}`),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [drafts, dirty, sessionData?.id]);
  async function task(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }
  async function saveDrafts() {
    if (!sessionData) return;
    const id = sessionData.id,
      values = draftsRef.current,
      revision = draftRevision.current;
    return draftSaveQueue.current.enqueue(async () => {
      const saved: ReviewDraft[] = [];
      for (const draft of values) {
        saved.push(
          draft.state === 'draft'
            ? await api<ReviewDraft>(`/sessions/${id}/drafts/${draft.snapshotId}`, 'PUT', draft)
            : draft,
        );
      }
      // A slow response must never replace comments typed during the request.
      if (liveSession.current === id && draftRevision.current === revision) {
        draftsRef.current = saved;
        setDrafts(saved);
        setDirty(false);
        try {
          clearDraftCache(id);
        } catch {
          /* Server copy is already durable. */
        }
      }
      return saved;
    });
  }
  function updateDraft(draft: ReviewDraft) {
    if (
      reviewVersion &&
      !sessionData?.snapshots.some((snapshot) => snapshot.id === draft.snapshotId)
    )
      return;
    const next = draftsRef.current.map((d) => (d.snapshotId === draft.snapshotId ? draft : d));
    draftRevision.current++;
    draftsRef.current = next;
    if (sessionData) {
      try {
        cacheDrafts(sessionData.id, next);
      } catch {
        setError(
          'Резервная копия в браузере недоступна. Дождитесь сохранения черновика перед обновлением страницы.',
        );
      }
    }
    setDrafts(next);
    setDirty(true);
  }
  async function selectSession(id: string) {
    await task('Открываем сессию', async () => {
      if (dirty) await saveDrafts();
      await load(id);
    });
  }
  const selectedSnapshots =
    session?.snapshots.filter((s) => service === 'all' || s.repoId === service) ?? [];
  const matches = (refs: Evidence[]) => service === 'all' || refs.some((e) => e.repoId === service);
  const result = session?.run?.result;
  const repoName = (id: string) => {
    const owner = databaseOwner(id);
    const name =
      session?.snapshots.find((s) => s.repoId === (owner ?? id))?.repoName ?? owner ?? id;
    return owner ? `БД · ${name}` : name;
  };
  function syncSourceFile(evidence: Evidence, snapshots: Snapshot[]) {
    const snapshot = snapshots.find((item) => item.repoId === evidence.repoId);
    if (!snapshot) return;
    setReviewRepo(snapshot.id);
    const changed = snapshot.files.find((item) =>
      evidence.side === 'base'
        ? (item.oldPath ?? item.path) === evidence.path
        : item.path === evidence.path,
    );
    setFile(changed?.path ?? evidence.path);
  }
  async function openSource(evidence: Evidence, versionId = reviewVersion?.id ?? 'current') {
    const request = ++sourceRequest.current;
    await task('Открываем код', async () => {
      if (!session) return;
      const version = sourceVersion;
      const context =
        versionId === 'current'
          ? sessionData
          : sessionData?.history?.find((revision) => revision.id === versionId);
      const snapshot = context?.snapshots.find((snapshot) => snapshot.repoId === evidence.repoId);
      if (!snapshot) throw new Error('Снимок этой версии не найден.');
      const comparison =
        sourceComparisonId && versionId === 'current' && evidence.side === 'head'
          ? await api<CodeComparison>(
              `/sessions/${session.id}/code-comparison?${new URLSearchParams({ repoId: evidence.repoId, path: evidence.path, revisionId: sourceComparisonId })}`,
            )
          : undefined;
      const { text } =
        comparison ??
        (await api<{ text: string }>(
          `/sessions/${session.id}/source?${new URLSearchParams({ repoId: evidence.repoId, side: evidence.side, path: evidence.path, snapshotId: snapshot.id })}`,
        ));
      if (comparison) evidence = { ...evidence, path: comparison.path };
      if (
        request !== sourceRequest.current ||
        liveSession.current !== session.id ||
        liveSourceVersion.current !== version
      )
        return;
      syncSourceFile(evidence, context!.snapshots);
      setSource({ evidence, text, versionId, comparison, visitId: ++sourceSerial.current });
      setSourceNavigation({ back: [], forward: [] });
      setDefinitionPicker(null);
      setComment('');
    });
  }
  const sourceSelection = source?.selection ?? source?.evidence;
  const sourceContext =
    source?.versionId === 'current'
      ? sessionData
      : (sessionData?.history?.find((revision) => revision.id === source?.versionId) ?? session);
  const sourceSnapshot = sourceContext?.snapshots.find(
    (snapshot) => snapshot.repoId === source?.evidence.repoId,
  );
  const fileViews = useViewedFiles(sessionData?.id, [
    ...(session?.snapshots ?? []),
    ...(sourceSnapshot ? [sourceSnapshot] : []),
  ]);
  const methodViews = useViewedMethods(sessionData?.id, sourceSnapshot, source?.evidence);
  const reviewDiscussion = useReviewDiscussion(
    sessionData?.id,
    sessionData?.update?.id,
    sessionData?.threadDiscussion ?? sessionData?.discussion ?? [],
  );
  const sourceThreads =
    source && sourceSnapshot
      ? sourceDiscussions(
          reviewDiscussion.comments,
          sourceSnapshot,
          source.evidence,
          sourceSnapshot.headSha ===
            sessionData?.snapshots.find((snapshot) => snapshot.repoId === sourceSnapshot.repoId)
              ?.headSha &&
            sourceSnapshot.mergeBase ===
              sessionData?.snapshots.find((snapshot) => snapshot.repoId === sourceSnapshot.repoId)
                ?.mergeBase,
          [...drafts, ...(sessionData?.history ?? []).flatMap((revision) => revision.drafts)],
        )
      : [];
  const sourcePreviousRevision = sessionData?.history?.find(
    (revision) => revision.id === source?.comparison?.previousRevisionId,
  );
  const sourcePreviousSnapshot = sourcePreviousRevision?.snapshots.find(
    (snapshot) => snapshot.id === source?.comparison?.previousSnapshotId,
  );
  const sourcePreviousDrafts = (sourcePreviousRevision?.drafts ?? []).filter(
    (draft) => draft.snapshotId === sourcePreviousSnapshot?.id,
  );
  const sourcePreviousThreads =
    source && sourcePreviousSnapshot
      ? sourceDiscussions(
          reviewDiscussion.comments,
          sourcePreviousSnapshot,
          { ...source.evidence, path: source.comparison!.previousPath, side: 'head' },
          false,
          [...drafts, ...(sessionData?.history ?? []).flatMap((revision) => revision.drafts)],
        )
      : [];
  const sourceReadOnly =
    source?.versionId !== 'current' ||
    !sourceSnapshot?.pr ||
    !drafts.some((draft) => draft.snapshotId === sourceSnapshot.id && draft.state === 'draft');
  const sourceDrafts =
    source?.versionId === 'current'
      ? drafts
      : (sessionData?.history?.find((revision) => revision.id === source?.versionId)?.drafts ?? []);
  const sourceComments = sourceDrafts
    .filter(
      (draft) =>
        draft.snapshotId === sourceSnapshot?.id && draft.headSha === sourceSnapshot?.headSha,
    )
    .flatMap((draft) => draft.comments);
  const sourceChangedFile =
    source &&
    sourceContext?.snapshots
      .find((s) => s.repoId === source.evidence.repoId)
      ?.files.find((f) =>
        source.evidence.side === 'head'
          ? f.path === source.evidence.path
          : (f.oldPath ?? f.path) === source.evidence.path,
      );
  const codeLinks = useMemo(
    () =>
      source
        ? methodLinks(source.text, source.evidence, sourceContext?.run?.result.indexes ?? [])
        : [],
    [
      source?.text,
      source?.evidence.repoId,
      source?.evidence.side,
      source?.evidence.path,
      sourceContext,
    ],
  );
  function captureVisit(page = source): SourceVisit | null {
    return page
      ? {
          page,
          comment: sourceComment.current,
          position: {
            top: sourceViewport.current?.scrollTop ?? 0,
            left: sourceViewport.current?.scrollLeft ?? 0,
          },
        }
      : null;
  }
  async function navigateDefinition(evidence: Evidence, line: number) {
    if (!source || !session) return;
    const origin = source;
    const version = sourceVersion;
    const visit = captureVisit({
      ...origin,
      evidence: { ...origin.evidence, startLine: line, endLine: line },
    })!;
    await task('Открываем определение', async () => {
      const comparison =
        origin.comparison && evidence.side === 'head'
          ? evidence.path === origin.evidence.path && evidence.repoId === origin.evidence.repoId
            ? origin.comparison
            : await api<CodeComparison>(
                `/sessions/${session.id}/code-comparison?${new URLSearchParams({ repoId: evidence.repoId, path: evidence.path, revisionId: origin.comparison.previousRevisionId })}`,
              )
          : undefined;
      const text =
        comparison?.text ??
        (evidence.path === origin.evidence.path &&
        evidence.repoId === origin.evidence.repoId &&
        evidence.side === origin.evidence.side
          ? origin.text
          : (
              await api<{ text: string }>(
                `/sessions/${session.id}/source?${new URLSearchParams({ repoId: evidence.repoId, side: evidence.side, path: evidence.path, snapshotId: sourceContext!.snapshots.find((s) => s.repoId === evidence.repoId)!.id })}`,
              )
            ).text);
      if (
        liveSession.current !== session.id ||
        liveSourceVersion.current !== version ||
        activeSource.current?.visitId !== origin.visitId
      )
        return;
      visit.comment = sourceComment.current;
      if (visit.comment.trim() && activeSource.current)
        visit.page.evidence = activeSource.current.evidence;
      setSourceNavigation((previous) => ({ back: [...previous.back, visit], forward: [] }));
      syncSourceFile(evidence, sourceContext!.snapshots);
      setSource({
        evidence: comparison ? { ...evidence, path: comparison.path } : evidence,
        text,
        comparison,
        versionId: origin.versionId,
        visitId: ++sourceSerial.current,
      });
      setComment('');
      setDefinitionPicker(null);
    });
  }
  function followDefinition(link: MethodLink) {
    if (needsDefinitionPicker(link)) setDefinitionPicker(link);
    else void navigateDefinition(link.targets[0].evidence, link.line);
  }
  function sourceBack(forward = false) {
    const stack = forward ? sourceNavigation.forward : sourceNavigation.back;
    const target = stack.at(-1),
      current = captureVisit();
    if (!target || !current) return;
    setSourceNavigation(
      forward
        ? { back: [...sourceNavigation.back, current], forward: stack.slice(0, -1) }
        : { back: stack.slice(0, -1), forward: [...sourceNavigation.forward, current] },
    );
    const context =
      target.page.versionId === 'current'
        ? sessionData
        : sessionData?.history?.find((revision) => revision.id === target.page.versionId);
    if (context) syncSourceFile(target.page.evidence, context.snapshots);
    setSource({ ...target.page, position: target.position, visitId: ++sourceSerial.current });
    setComment(target.comment);
    setDefinitionPicker(null);
  }
  function evidenceLinks(refs: Evidence[], versionId = reviewVersion?.id ?? 'current') {
    return (
      <div className="evidence">
        {refs.map((e, i) => (
          <button
            key={i}
            onClick={() => {
              if (tab === 'review') setDraftDialog(false);
              void openSource(e, versionId);
            }}
            title={`${repoName(e.repoId)} · ${e.side}`}
          >
            <span>↗</span> {e.path.split('/').pop()}:{e.startLine}
          </button>
        ))}
      </div>
    );
  }
  function addComment(body: string, evidence: Evidence | null) {
    if (reviewVersion && source?.versionId !== 'current') return false;
    const target = draftForEvidence(evidence);
    if (!target) {
      setError('Нет доступного черновика. Для добавления замечаний нужна сессия с PR.');
      return false;
    }
    updateDraft({
      ...target,
      comments: [...target.comments, { id: crypto.randomUUID(), body, evidence, selected: true }],
    });
    setNotice('Комментарий добавлен в черновик и сохраняется автоматически.');
    setTimeout(() => setNotice(''), 5000);
    return true;
  }
  function draftForEvidence(evidence: Evidence | null) {
    const snap = sessionData?.snapshots.find((s) => s.repoId === evidence?.repoId && s.pr);
    return (
      drafts.find((d) => d.snapshotId === (snap?.id ?? reviewRepo) && d.state === 'draft') ??
      drafts.find((d) => d.state === 'draft')
    );
  }
  function findingCard(f: Finding) {
    return (
      <article className={`finding ${f.severity}`} key={f.id}>
        <div className="card-top">
          <span className={`risk ${f.severity}`}>{severity[f.severity]}</span>
          <Badge value={f.confidence} />
        </div>
        <h3>{f.title}</h3>
        <p>{f.summary}</p>
        {evidenceLinks(f.evidence)}
        <button
          className="text-button"
          disabled={!!reviewVersion}
          onClick={() => addComment(`${f.title}\n\n${f.summary}`, f.evidence[0] ?? null)}
        >
          ＋ В черновик ревью
        </button>
      </article>
    );
  }
  const currentSnapshot =
    session?.snapshots.find((s) => s.id === reviewRepo) ??
    session?.snapshots.find((s) => s.pr) ??
    session?.snapshots[0];
  const currentDraft = (reviewVersion?.drafts ?? drafts).find(
    (d) => d.snapshotId === currentSnapshot?.id,
  );
  const selectedPath = file || currentSnapshot?.files[0]?.path || currentSnapshot?.headFiles[0];
  useEffect(() => {
    if (tab !== 'review' || source || !session || !currentSnapshot || !selectedPath) return;
    void openSource({
      repoId: currentSnapshot.repoId,
      path: selectedPath,
      side: currentSnapshot.headFiles.includes(selectedPath) ? 'head' : 'base',
      startLine: 1,
      endLine: 1,
    });
  }, [tab, session?.id, currentSnapshot?.id, selectedPath, source?.visitId]);

  const comparisonRevision = sessionData?.history?.find(
    (revision) =>
      revision.id === (sessionData.run?.previousReviewId ?? sessionData.update?.previousReviewId),
  );
  const scenarioUpdates = useMemo(
    () =>
      comparisonRevision && sessionData?.run
        ? scenarioChanges(
            sessionData.run.result.scenarios,
            comparisonRevision.run.result.scenarios,
            sessionData.update?.changes ?? [],
            {
              current: scenarioRoots(sessionData.snapshots, sessionData.run.result.indexes),
              previous: scenarioRoots(
                comparisonRevision.snapshots,
                comparisonRevision.run.result.indexes,
              ),
            },
            {
              current: (step) =>
                scenarioStepMeaning(step, sessionData.run!.result.indexes, sessionData.snapshots),
              previous: (step) =>
                scenarioStepMeaning(
                  step,
                  comparisonRevision.run.result.indexes,
                  comparisonRevision.snapshots,
                ),
            },
          )
        : new Map(),
    [sessionData?.run?.result.scenarios, comparisonRevision, sessionData?.update],
  );
  const scenarioMenuUpdates = new Map(scenarioUpdates);
  for (const change of scenarioUpdates.values())
    if (change.previous && !scenarioMenuUpdates.has(change.previous.id))
      scenarioMenuUpdates.set(change.previous.id, change);
  const showScenarioUpdates = (id: string) => {
    const target =
      [...scenarioUpdates].find(([, change]) => change.previous?.id === id)?.[0] ??
      (scenarioUpdates.has(id) ? id : undefined);
    setScenarioId(target ?? id);
    setRevisionId('current');
  };
  const scenarios = result?.scenarios.filter((s) => matches(s.evidence)) ?? [];
  const selectedScenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0];
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
        ? sequenceView(expandedScenario, result?.indexes ?? [], collapsedServices)
        : null,
    [expandedScenario, result, collapsedServices],
  );
  const scenario = diagram?.scenario;
  const allInternalsExpanded =
    !!diagram &&
    diagram.owners
      .filter((id) => (diagram.internalCount.get(id) ?? 0) > 0)
      .every((id) => !collapsedServices.has(id));
  const participantName = (id: string) => {
    const participant = diagram?.participants.find((p) => p.id === id);
    return participant?.kind === 'class' || participant?.kind === 'external'
      ? participant.label
      : repoName(id);
  };
  const toggleService = (id: string) =>
    setCollapsedServices((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const txRegions = useMemo(
    () => (scenario && result ? transactionRegions(scenario, result) : []),
    [scenario, result],
  );
  const contracts =
    result?.contracts.filter((c) => service === 'all' || c.repoId === service) ?? [];
  const contract = contracts.find((c) => c.id === contractId) ?? contracts[0];
  const canAnalyze = sessionData && liveRun?.state !== 'running' && liveRun?.state !== 'complete';
  const prLabel = session?.snapshots
    .filter((s) => s.pr)
    .map((s) => `PR #${s.pr!.number}`)
    .join(' + ');
  const sourceKeyboard = (e: React.KeyboardEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const back = (e.metaKey && e.key === '[') || (e.altKey && e.key === 'ArrowLeft');
    const forward = (e.metaKey && e.key === ']') || (e.altKey && e.key === 'ArrowRight');
    if (back || forward) {
      e.preventDefault();
      sourceBack(forward);
    }
  };
  async function changeSourceComparison(revisionId: string) {
    if (!source || !sessionData) return;
    const origin = source,
      sessionId = sessionData.id;
    const version = sourceVersion;
    const request = ++sourceRequest.current;
    await task('Сравниваем код', async () => {
      if (!revisionId) {
        setSourceComparisonId('');
        setSource({
          ...origin,
          comparison: undefined,
          selection: undefined,
          visitId: ++sourceSerial.current,
        });
        return;
      }
      const comparison = await api<CodeComparison>(
        `/sessions/${sessionId}/code-comparison?${new URLSearchParams({ repoId: origin.evidence.repoId, path: origin.evidence.path, revisionId })}`,
      );
      if (
        liveSession.current !== sessionId ||
        sourceRequest.current !== request ||
        liveSourceVersion.current !== version
      )
        return;
      let startLine = origin.evidence.startLine,
        endLine = origin.evidence.endLine;
      if (origin.versionId !== 'current' || origin.evidence.side !== 'head') {
        startLine = 1;
        if (sourceSnapshot?.headSha === comparison.previousSha && origin.evidence.side === 'head') {
          const rows = reviewDiffRows(
            comparison.text,
            { ...origin.evidence, side: 'head', path: comparison.path },
            comparison.file,
            comparison.previousPath,
          );
          const anchor = rows.findIndex((row) => row.left === origin.evidence.startLine);
          startLine = anchor >= 0 ? (rows.slice(anchor).find((row) => row.native)?.right ?? 1) : 1;
        }
        endLine = startLine;
      }
      const evidence = {
        ...origin.evidence,
        side: 'head' as const,
        path: comparison.path,
        startLine,
        endLine,
      };
      setSourceComparisonId(revisionId);
      syncSourceFile(evidence, sessionData.snapshots);
      const page: SourcePage = {
        evidence,
        text: comparison.text,
        comparison,
        versionId: 'current',
        visitId: ++sourceSerial.current,
      };
      const currentVersion = sessionData.snapshots.map((snapshot) => snapshot.id).join(',');
      if (sourceVersion !== currentVersion) {
        sourceRestore.current = { version: currentVersion, page };
        setRevisionId('current');
      }
      setSource(page);
      setSourceNavigation({ back: [], forward: [] });
      setDefinitionPicker(null);
    });
  }
  async function navigatePreviousCode(evidence: Evidence) {
    if (!source?.comparison || !sessionData) return;
    const origin = source,
      comparison = source.comparison,
      visit = captureVisit(source)!;
    const sessionId = sessionData.id;
    await task('Открываем код прошлого ревью', async () => {
      const { text } = await api<{ text: string }>(
        `/sessions/${sessionId}/source?${new URLSearchParams({ repoId: evidence.repoId, side: 'head', path: evidence.path, snapshotId: comparison.previousSnapshotId })}`,
      );
      if (liveSession.current !== sessionId || activeSource.current?.visitId !== origin.visitId)
        return;
      setSourceNavigation((previous) => ({ back: [...previous.back, visit], forward: [] }));
      setSource({
        evidence,
        text,
        versionId: comparison.previousRevisionId,
        visitId: ++sourceSerial.current,
      });
      setComment('');
      setDefinitionPicker(null);
    });
  }
  function renderSourcePanel() {
    if (!source) return null;
    return (
      <>
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">
              {repoName(source.evidence.repoId)} ·{' '}
              {source.evidence.side === 'head' ? 'ПОСЛЕ ИЗМЕНЕНИЯ' : 'ДО ИЗМЕНЕНИЯ'}
              {' · '}
              {sourceContext?.snapshots
                .find((snapshot) => snapshot.repoId === source.evidence.repoId)
                ?.headSha?.slice(0, 7)}
            </span>
            <h3>{source.evidence.path}</h3>
          </div>
          {tab !== 'review' && (
            <button onClick={() => setSource(null)} aria-label="Закрыть код">
              ×
            </button>
          )}
        </div>
        <div className="source-navigation" aria-label="История просмотра кода">
          <button
            disabled={!sourceNavigation.back.length}
            onClick={() => sourceBack()}
            title="⌘[ / Alt+←"
          >
            ← Назад
          </button>
          <button
            disabled={!sourceNavigation.forward.length}
            onClick={() => sourceBack(true)}
            title="⌘] / Alt+→"
          >
            Вперёд →
          </button>
          <span className="source-location">
            {source.evidence.path.split('/').pop()}:{source.evidence.startLine}
          </span>
          <button
            disabled={reviewDiscussion.loading}
            onClick={() => void reviewDiscussion.reload()}
          >
            {reviewDiscussion.loading ? 'Загружаем ответы…' : 'Обновить ответы'}
          </button>
          {sourceSnapshot && (
            <label className="file-view-checkbox">
              <input
                type="checkbox"
                checked={fileViews.isViewed(sourceSnapshot, source.evidence.path)}
                disabled={
                  fileViews.loading || fileViews.isPending(sourceSnapshot, source.evidence.path)
                }
                onChange={(event) =>
                  void fileViews.setViewed(
                    sourceSnapshot,
                    source.evidence.path,
                    event.target.checked,
                  )
                }
              />
              Просмотрен
            </label>
          )}
        </div>
        {(sessionData?.history?.length ?? 0) > 0 && (
          <div className="source-comparison-controls">
            <label>
              Сравнение кода{' '}
              <select
                aria-label="Сравнение кода"
                value={source.comparison?.previousRevisionId ?? ''}
                disabled={!!busy || !!comment.trim()}
                title={comment.trim() ? 'Сначала добавьте или отмените комментарий' : undefined}
                onChange={(event) => void changeSourceComparison(event.target.value)}
              >
                <option value="">Изменения PR относительно исходной ветки</option>
                {[...(sessionData?.history ?? [])]
                  .reverse()
                  .filter((revision) =>
                    revision.snapshots.some(
                      (snapshot) => snapshot.repoId === source.evidence.repoId,
                    ),
                  )
                  .map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      С ревью {new Date(revision.savedAt).toLocaleString('ru')} ·{' '}
                      {revision.snapshots
                        .find((snapshot) => snapshot.repoId === source.evidence.repoId)!
                        .headSha.slice(0, 7)}
                    </option>
                  ))}
              </select>
            </label>
            {source.comparison && (
              <span>
                Прошлое ревью {source.comparison.previousSha.slice(0, 7)} → текущий код{' '}
                {source.comparison.currentSha.slice(0, 7)}
                {source.comparison.file.status === 'unchanged' ? ' · Файл не менялся' : ''}
              </span>
            )}
            {!!comment.trim() && (
              <small>Сначала добавьте или отмените комментарий, чтобы сменить сравнение.</small>
            )}
          </div>
        )}
        {reviewDiscussion.error && (
          <p className="discussion-load-error" role="alert">
            {reviewDiscussion.error}
          </p>
        )}
        {definitionPicker && (
          <div className="definition-picker" role="region" aria-label="Выбор определения метода">
            <strong>Возможные определения {definitionPicker.name}</strong>
            {definitionPicker.targets.map((method, i) => (
              <button
                key={i}
                onClick={() => void navigateDefinition(method.evidence, definitionPicker.line)}
              >
                {method.evidence.path}:{method.evidence.startLine} · {method.signature}
              </button>
            ))}
            <button onClick={() => setDefinitionPicker(null)}>Отмена перехода</button>
          </div>
        )}
        <SourceCode
          links={codeLinks}
          onDefinition={followDefinition}
          visitId={source.visitId}
          position={source.position}
          viewportRef={sourceViewport}
          text={source.text}
          evidence={source.evidence}
          selection={source.selection}
          changedFile={source.comparison?.file ?? (sourceChangedFile || undefined)}
          comparison={source.comparison}
          previousComments={sourcePreviousDrafts
            .flatMap((draft) => draft.comments)
            .filter(
              (comment) =>
                !sourcePreviousThreads.some((thread) => thread.localCommentId === comment.id),
            )}
          previousDiscussions={sourcePreviousThreads}
          onHistoricalSource={(evidence) => void navigatePreviousCode(evidence)}
          comments={sourceComments.filter(
            (comment) => !sourceThreads.some((thread) => thread.localCommentId === comment.id),
          )}
          discussions={sourceThreads}
          discussionSessionId={sessionData?.id}
          onDiscussionReply={reviewDiscussion.reply}
          onDiscussionReaction={reviewDiscussion.react}
          onDeleteComment={
            sourceReadOnly
              ? undefined
              : (id) => {
                  const target = drafts.find(
                    (draft) =>
                      draft.snapshotId === sourceSnapshot?.id &&
                      draft.headSha === sourceSnapshot?.headSha &&
                      draft.state === 'draft' &&
                      draft.comments.some((comment) => comment.id === id),
                  );
                  if (target)
                    updateDraft({
                      ...target,
                      comments: target.comments.filter((comment) => comment.id !== id),
                    });
                }
          }
          methods={methodViews.methods}
          methodPending={methodViews.pending}
          methodError={methodViews.error}
          onMethodViewed={(entry, viewed) => void methodViews.setViewed(entry, viewed)}
          commentEditor={
            sourceReadOnly ? undefined : (
              <div className="source-comment">
                <button
                  className="source-comment-close"
                  aria-label="Отменить комментарий"
                  title="Отменить комментарий"
                  onClick={() => {
                    setComment('');
                    sourceComment.current = '';
                    setSource({ ...source, selection: undefined });
                  }}
                >
                  ×
                </button>
                <label htmlFor="source-comment" className="field-label">
                  Комментарий{' '}
                  {sourceSelection!.startLine === sourceSelection!.endLine
                    ? `к строке ${sourceSelection!.startLine}`
                    : `к строкам ${sourceSelection!.startLine}–${sourceSelection!.endLine}`}
                  {sourceSelection!.side !== source.evidence.side
                    ? sourceSelection!.side === 'base'
                      ? ' · до изменения'
                      : ' · после изменения'
                    : ''}
                </label>
                <textarea
                  id="source-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Опишите замечание…"
                />
                <button
                  className="primary"
                  disabled={!comment.trim()}
                  onClick={() => {
                    if (addComment(comment, sourceSelection!)) {
                      setComment('');
                      setSource({ ...source, selection: undefined });
                    }
                  }}
                >
                  Добавить в черновик
                </button>
              </div>
            )
          }
          onSelect={(line, reference) =>
            setSource({
              ...source,
              selection: reference ?? { ...source.evidence, startLine: line, endLine: line },
            })
          }
        />
      </>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            r<span>•</span>
          </div>
          <div>
            review<span>FREE SOLO LAB</span>
          </div>
        </div>
        <button className="new-session" onClick={() => setSetup(true)}>
          ＋ Новое ревью <kbd>PR</kbd>
        </button>
        <div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
              title={label}
            >
              <span className="nav-icon">{navIcons[id]}</span>
              {label}
              {id === 'review' && drafts.some((d) => d.comments.length > 0) && (
                <i>{drafts.reduce((n, d) => n + d.comments.length, 0)}</i>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label sessions-label">
          НЕДАВНИЕ РЕВЬЮ <span>{sessions.length}</span>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <div key={s.id} className={`session-row ${session?.id === s.id ? 'selected' : ''}`}>
              <button className="session-open" onClick={() => void selectSession(s.id)}>
                <span className={`status-dot ${s.state}`} />
                <span>
                  {s.title}
                  <small>
                    {s.services} сервис(а) · {new Date(s.createdAt).toLocaleDateString('ru')}
                  </small>
                </span>
              </button>
              <button
                className="session-delete"
                title="Удалить сохранённое ревью"
                aria-label={`Удалить сохранённое ревью: ${s.title}`}
                disabled={
                  !!busy ||
                  s.state === 'running' ||
                  (s.id === sessionData?.id && liveRun?.state === 'running')
                }
                onClick={() => {
                  setError('');
                  setDeleteTarget(s);
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" />
                </svg>
              </button>
            </div>
          ))}
          {!sessions.length && <p className="sidebar-hint">Здесь появятся ваши сессии ревью</p>}
        </div>
        <div className="sidebar-bottom">
          <span className={`status-dot ${status?.login ? 'complete' : 'partial'}`} />
          <div>
            {status?.login ?? 'GitHub не подключён'}
            <small>{status?.login ? 'Локально · GitHub CLI' : 'Выполните gh auth login'}</small>
          </div>
          <span className="avatar">{status?.login?.slice(0, 2).toUpperCase() ?? 'GH'}</span>
        </div>
      </aside>
      <main
        className={
          session &&
          (tab === 'tests' ||
            tab === 'review' ||
            tab === 'sequence' ||
            tab === 'overview' ||
            tab === 'database')
            ? `secondary-menu-page full-workspace-page ${tab === 'review' ? 'review-workspace-page' : tab === 'sequence' ? 'sequence-workspace-page' : tab === 'overview' ? 'overview-workspace-page' : tab === 'database' ? 'database-workspace-page' : 'tests-workspace-page'}`
            : undefined
        }
      >
        <header className="topbar">
          <div className="breadcrumb">
            {session ? (
              <button className="breadcrumb-link" onClick={() => setTab('overview')}>
                {prLabel || session.title}
              </button>
            ) : (
              'Рабочее пространство'
            )}
            <span>/</span> <strong>{session?.title ?? 'Начало работы'}</strong>
          </div>
          {session && (
            <div className="topbar-actions">
              <span className={`run-state ${liveRun?.state ?? 'ready'}`}>
                <span className={`status-dot ${liveRun?.state ?? 'ready'}`} />
                {states[liveRun?.state ?? 'ready']}
              </span>
              <button
                disabled={!!busy || liveRun?.state === 'running'}
                onClick={() =>
                  void task('Обновляем снимки', async () => {
                    if (dirty) await saveDrafts();
                    const updated = await api<ReviewSession>(
                      `/sessions/${session.id}/refresh`,
                      'POST',
                      {},
                    );
                    if (sessionData && !hasRefreshChanges(sessionData, updated)) {
                      setSession(updated);
                      setNotice(
                        updated.refreshWarnings?.length
                          ? 'Не удалось проверить все ответы GitHub.'
                          : 'Новых изменений нет. Анализ и открытое место сохранены.',
                      );
                      window.setTimeout(() => setNotice(''), 5000);
                      return;
                    }
                    if (updated.update && !updated.run) {
                      await api(`/sessions/${session.id}/analyze`, 'POST', {});
                    }
                    await load(session.id);
                    setNotice(
                      updated.refreshWarnings?.length
                        ? 'PR обновлён, но обсуждение GitHub загружено не полностью.'
                        : updated.update && !updated.run
                          ? 'Обновления загружены. Дополнительный анализ запущен; прошлое ревью сохранено.'
                          : 'Новых изменений и ответов нет. Текущий анализ сохранён.',
                    );
                  })
                }
              >
                ↻ Проверить обновления
              </button>
              {liveRun?.state === 'running' ? (
                <button
                  onClick={() =>
                    void task('Отменяем анализ', async () => {
                      await api(`/sessions/${session.id}/cancel`, 'POST', {});
                    })
                  }
                >
                  Остановить
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!!busy || !canAnalyze}
                  onClick={() =>
                    void task('Запускаем анализ', async () => {
                      await api(
                        `/sessions/${session.id}/${liveRun?.scenariosBaseState && liveRun.state !== 'complete' ? 'scenario-analysis' : liveRun?.testsBaseState && liveRun.state !== 'complete' ? 'test-analysis' : liveRun?.sqlBaseState && liveRun.state !== 'complete' ? 'sql-analysis' : 'analyze'}`,
                        'POST',
                        {},
                      );
                      await load(session.id);
                    })
                  }
                >
                  ✧{' '}
                  {sessionData?.update && !liveRun
                    ? 'Проанализировать обновления'
                    : liveRun?.state === 'complete'
                      ? '✓ Версия уже проанализирована'
                      : liveRun
                        ? liveRun.state === 'partial' || liveRun.state === 'failed'
                          ? liveRun.scenariosBaseState
                            ? 'Дополнить сценарии'
                            : liveRun.testsBaseState
                              ? 'Повторить разбор тестов'
                              : liveRun.sqlBaseState
                                ? 'Повторить SQL'
                                : 'Повторить анализ'
                          : 'Дополнить анализ'
                        : 'Анализировать'}
                </button>
              )}
            </div>
          )}
        </header>
        <div className="content">
          <div className="mobile-sessions">
            <select
              aria-label="Открыть сессию"
              value={session?.id ?? ''}
              onChange={(e) => {
                if (e.target.value) void selectSession(e.target.value);
              }}
            >
              <option value="">Выберите ревью</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <button onClick={() => setSetup(true)}>＋ Новое</button>
          </div>
          {status?.demo && (
            <div className="alert notice">
              Демонстрационный режим. Данные анализа подготовлены заранее; отправка ревью
              имитируется и не обращается в GitHub.
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError('')}>×</button>
            </div>
          )}
          {fileViews.error && (
            <div className="alert error" role="alert">
              <span>{fileViews.error}</span>
              <button onClick={() => void fileViews.reload()}>Повторить</button>
            </div>
          )}
          {notice && (
            <div className="alert notice" role="status">
              {notice}
            </div>
          )}
          {!!sessionData?.history?.length && (
            <div className="review-history-bar">
              <label>
                Версия ревью
                <select
                  aria-label="Версия ревью"
                  value={revisionId || reviewVersion?.id || 'current'}
                  onChange={(event) => {
                    const id = event.target.value;
                    void task('Открываем версию', async () => {
                      if (dirty) await saveDrafts();
                      setRevisionId(id);
                      setSource(null);
                      setPreview(null);
                      setReviewRepo('');
                      setFile('');
                    });
                  }}
                >
                  <option value="current">
                    Текущая версия{!liveRun ? ' · ожидает анализа' : ''}
                  </option>
                  {[...sessionData.history].reverse().map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      Ревью от{' '}
                      {new Date(revision.run.finishedAt ?? revision.savedAt).toLocaleString('ru')} ·{' '}
                      {revision.snapshots
                        .filter((s) => s.pr)
                        .map((s) => s.headSha.slice(0, 7))
                        .join(', ')}
                    </option>
                  ))}
                </select>
              </label>
              <span>
                {reviewVersion
                  ? revisionId
                    ? 'Показана сохранённая версия ревью.'
                    : 'Исходное ревью сохранено без изменений. Обновления показаны отдельно.'
                  : 'Текущая версия PR'}
              </span>
              {reviewVersion && (
                <button
                  onClick={() => {
                    setRevisionId('current');
                    setTab('review');
                    setSource(null);
                  }}
                >
                  Открыть текущий код и ревью →
                </button>
              )}
            </div>
          )}
          {!!sessionData?.refreshWarnings?.length && <Gaps gaps={sessionData.refreshWarnings} />}
          {sessionData?.update && tab === 'overview' && (
            <section className="panel follow-up-panel">
              <div className="section-heading">
                <h2>После прошлого ревью</h2>
                <span className="kind">{new Date(sessionData.update.at).toLocaleString('ru')}</span>
              </div>
              <div className="follow-up-commits">
                {sessionData.update.changes.map((change) => (
                  <div key={change.repoId}>
                    <strong>{repoName(change.repoId)}</strong>{' '}
                    <code>
                      {change.fromSha.slice(0, 7)} → {change.toSha.slice(0, 7)}
                    </code>
                    <span> · {change.files.length} изменённых файлов после ревью</span>
                    {change.files.length > 0 && (
                      <details>
                        <summary>Изменённые файлы</summary>
                        <ul>
                          {change.files.map((f) => (
                            <li key={f.path}>
                              <details className="follow-up-file">
                                <summary>
                                  <code>{f.path}</code> · +{f.addedLines.length} −
                                  {f.removedLines.length}
                                </summary>
                                <Diff
                                  patch={f.patch}
                                  repoId={change.repoId}
                                  path={f.path}
                                  oldPath={f.oldPath}
                                  onSelect={(e) => {
                                    if (e.side === 'base')
                                      void openSource(
                                        { ...e, side: 'head' },
                                        sessionData.update!.previousReviewId,
                                      );
                                    else void openSource(e, 'current');
                                  }}
                                />
                              </details>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>
              {!liveRun && (
                <p>
                  Предыдущий анализ сохранён. Запустите «Проанализировать обновления», чтобы
                  проверить исправления и ответы.
                </p>
              )}
              {liveRun?.state === 'running' && (
                <p>Проверяем изменения и ответы. Предыдущее ревью доступно во время анализа.</p>
              )}
              {liveRun?.result.followUp && (
                <>
                  <Markdown>{liveRun.result.followUp.summary}</Markdown>
                  <div className="evidence">
                    {liveRun.result.scenarios
                      .filter((scenario) => {
                        const previous = sessionData.history
                          ?.find((revision) => revision.id === sessionData.update!.previousReviewId)
                          ?.run.result.scenarios.find((item) => item.id === scenario.id);
                        return !previous || JSON.stringify(previous) !== JSON.stringify(scenario);
                      })
                      .map((scenario) => (
                        <button
                          key={scenario.id}
                          onClick={() => {
                            setRevisionId('current');
                            setScenarioId(scenario.id);
                            setTab('sequence');
                            setSource(null);
                          }}
                        >
                          Изменённый сценарий: {scenario.title} →
                        </button>
                      ))}
                  </div>
                  <div className="follow-up-items">
                    {liveRun.result.followUp.items
                      .filter((item) => item.status !== 'still_present')
                      .map((item, index) => {
                        const prior = sessionData.history?.find(
                          (r) => r.id === sessionData.update!.previousReviewId,
                        );
                        const title =
                          prior?.run.result.findings.find((f) => f.id === item.previousId)?.title ??
                          prior?.drafts
                            .flatMap((d) => d.comments)
                            .find((c) => c.id === item.previousId)?.body;
                        const labels = {
                          fixed: 'Исправлено · оценка модели',
                          still_present: 'Остаётся актуальным',
                          answered: 'Получен ответ',
                          changed: 'Поведение изменилось',
                          unknown: 'Требует проверки',
                        };
                        return (
                          <article
                            key={`${item.previousId}:${index}`}
                            className={`follow-up-item ${item.status}`}
                          >
                            <span className="kind">{labels[item.status]}</span>
                            <h3>{title ?? item.previousId}</h3>
                            <Markdown>{item.summary}</Markdown>
                            {evidenceLinks(item.evidence, 'current')}
                          </article>
                        );
                      })}
                  </div>
                  {liveRun.result.followUp.items.some(
                    (item) => item.status === 'still_present',
                  ) && (
                    <details>
                      <summary>
                        Без изменений ·{' '}
                        {
                          liveRun.result.followUp.items.filter(
                            (item) => item.status === 'still_present',
                          ).length
                        }
                      </summary>
                      {liveRun.result.followUp.items
                        .filter((item) => item.status === 'still_present')
                        .map((item) => (
                          <article key={item.previousId}>
                            <Markdown>{item.summary}</Markdown>
                            {evidenceLinks(item.evidence, 'current')}
                          </article>
                        ))}
                    </details>
                  )}
                </>
              )}
              {sessionData.update.discussion.length > 0 && (
                <details className="follow-up-discussion">
                  <summary>
                    Новые ответы и комментарии в GitHub · {sessionData.update.discussion.length}
                  </summary>
                  {sessionData.update.discussion.map((reply) => (
                    <article key={`${reply.repoId}:${reply.id}`}>
                      <a href={reply.url} target="_blank" rel="noreferrer">
                        {reply.author} ↗
                      </a>
                      <Markdown>{reply.body}</Markdown>
                    </article>
                  ))}
                </details>
              )}
              <Gaps gaps={sessionData.update.gaps} />
            </section>
          )}
          {!session ? (
            <section className="welcome">
              <div className="eyebrow">ПОНИМАЙТЕ ИЗМЕНЕНИЯ ЦЕЛИКОМ</div>
              <h1>
                От строк кода —<br />к поведению системы.
              </h1>
              <p>
                Откройте PR, проследите вызовы между сервисами и проведите ревью с полным
                контекстом.
              </p>
              <button className="primary" onClick={() => setSetup(true)}>
                Создать первое ревью <span>↗</span>
              </button>
              <div className="welcome-grid">
                {[
                  ['01', 'Подключите код', 'Локальные репозитории и pull requests из GitHub.'],
                  [
                    '02',
                    'Исследуйте изменения',
                    'Диаграммы, контракты, SQL и тесты со ссылками на код.',
                  ],
                  [
                    '03',
                    'Отправьте ревью',
                    'Проверьте замечания и опубликуйте решение от своего имени.',
                  ],
                ].map(([n, t, p]) => (
                  <article key={n}>
                    <span>{n}</span>
                    <h3>{t}</h3>
                    <p>{p}</p>
                  </article>
                ))}
              </div>
              <div className="connection-note">
                <span>⌁</span> Codex анализирует переданный контекст. Исходный код не запускается.
              </div>
              {status?.githubError && (
                <p className="connection-error">GitHub: {status.githubError}</p>
              )}
            </section>
          ) : (
            <>
              {liveRun &&
                liveRun.state !== 'running' &&
                (liveRun.error ||
                  liveRun.result.gaps.find((gap) => gap.startsWith('Codex/анализ:'))) && (
                  <div className="panel analysis-error" role="alert">
                    <strong>Разбор Codex не завершён</strong>
                    <p>
                      Извлечённые данные сохранены. Нажмите «Повторить анализ», чтобы получить
                      разбор без удаления PR.
                    </p>
                    <details>
                      <summary>Причина ошибки</summary>
                      <pre>
                        {liveRun.error ??
                          liveRun.result.gaps.find((gap) => gap.startsWith('Codex/анализ:'))}
                      </pre>
                    </details>
                  </div>
                )}
              {!result &&
              tab !== 'review' &&
              tab !== 'database' &&
              tab !== 'tests' &&
              tab !== 'sequence' ? (
                <Empty title="Код зафиксирован. Можно начинать.">
                  Нажмите «Анализировать», чтобы построить представления этой версии PR.
                </Empty>
              ) : (
                <>
                  {tab === 'overview' && result && (
                    <OverviewView
                      key={`${session.id}:${reviewVersion?.id ?? 'current'}`}
                      summary={result.summary}
                      scenarios={result.scenarios}
                      snapshots={session.snapshots}
                      service={service}
                      onService={setService}
                      changes={scenarioMenuUpdates}
                      showingPrevious={!!reviewVersion}
                      onLatest={showScenarioUpdates}
                      initialSelectedId={scenarioId}
                      onDiagram={(id) => {
                        setScenarioId(id);
                        setTab('sequence');
                      }}
                      missingCount={
                        missingScenarios(
                          scenarioRoots(session.snapshots, result.indexes),
                          result.scenarios,
                        ).length
                      }
                      running={liveRun?.state === 'running'}
                      canAnalyze={!reviewVersion}
                      onAnalyze={async () => {
                        await api(`/sessions/${sessionData!.id}/scenario-analysis`, 'POST', {});
                        const updated = await api<ReviewSession>(`/sessions/${sessionData!.id}`);
                        if (liveSession.current === updated.id) setSession(updated);
                      }}
                    >
                      <div className="service-cards">
                        {selectedSnapshots.map((s) => (
                          <div key={s.id}>
                            <div className="service-icon">▧</div>
                            <div>
                              <strong>{s.repoName}</strong>
                              <small>
                                {s.files.length} изменённых файлов ·{' '}
                                {s.pr ? `PR #${s.pr.number}` : 'контекст'}
                              </small>
                            </div>
                            {s.pr && (
                              <a href={s.pr.url} target="_blank" rel="noreferrer">
                                ↗
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="section-heading">
                        <span>
                          {result.findings.filter((f) => matches(f.evidence)).length} замечаний
                        </span>
                      </div>
                      <div className="findings-grid">
                        {result.findings.filter((f) => matches(f.evidence)).map(findingCard)}
                      </div>
                      {!result.findings.length && (
                        <Empty title="Подтверждённых замечаний пока нет">
                          Это не означает отсутствие ошибок. Проверьте полноту анализа и изменения
                          кода.
                        </Empty>
                      )}
                      <Gaps gaps={result.gaps} />
                      {session.run?.events.length ? (
                        <details className="panel logs">
                          <summary>Журнал анализа</summary>
                          {session.run.events.map((e) => (
                            <p key={e.seq}>
                              <time>{new Date(e.at).toLocaleTimeString('ru')}</time> {e.message}
                            </p>
                          ))}
                        </details>
                      ) : null}
                    </OverviewView>
                  )}
                  {tab === 'sequence' && (
                    <>
                      <ScenariosMenu
                        key={session.id}
                        scenarios={result?.scenarios ?? []}
                        changes={scenarioMenuUpdates}
                        snapshots={session.snapshots}
                        selectedId={selectedScenario?.id}
                        service={service}
                        onService={(id) => {
                          setService(id);
                          setScenarioId('');
                        }}
                        onSelect={setScenarioId}
                        missingCount={
                          missingScenarios(
                            scenarioRoots(session.snapshots, result?.indexes ?? []),
                            result?.scenarios ?? [],
                          ).length
                        }
                        running={liveRun?.state === 'running'}
                        canAnalyze={!reviewVersion}
                        onAnalyze={async () => {
                          await api(`/sessions/${sessionData!.id}/scenario-analysis`, 'POST', {});
                          const updated = await api<ReviewSession>(`/sessions/${sessionData!.id}`);
                          if (liveSession.current === updated.id) setSession(updated);
                        }}
                      />
                      {scenario ? (
                        <section
                          className="sequence-workspace"
                          aria-label="Диаграмма взаимодействий"
                        >
                          <header className="sequence-workspace-toolbar">
                            <div className="sequence-workspace-title">
                              <h2>{scenario.title}</h2>
                              <Badge value={scenario.confidence} />
                              {!reviewVersion && scenarioMenuUpdates.has(selectedScenario!.id) && (
                                <span className="scenario-change-badge">
                                  Изменения после прошлого ревью
                                </span>
                              )}
                            </div>
                            {diagram &&
                              diagram.owners.some(
                                (id) => (diagram.internalCount.get(id) ?? 0) > 0,
                              ) && (
                                <div
                                  className="sequence-controls"
                                  aria-label="Детализация сервисов"
                                >
                                  <button
                                    className="sequence-detail-toggle"
                                    aria-pressed={allInternalsExpanded}
                                    aria-label={
                                      allInternalsExpanded
                                        ? 'Свернуть внутренние вызовы всех сервисов'
                                        : 'Развернуть внутренние вызовы всех сервисов'
                                    }
                                    title={
                                      allInternalsExpanded
                                        ? 'Свернуть внутренние вызовы всех сервисов'
                                        : 'Развернуть внутренние вызовы всех сервисов'
                                    }
                                    onClick={() =>
                                      setCollapsedServices(
                                        new Set(allInternalsExpanded ? diagram.owners : []),
                                      )
                                    }
                                  >
                                    <span className="sequence-toggle-track" aria-hidden="true">
                                      <span />
                                    </span>
                                    Внутренние вызовы
                                  </button>
                                </div>
                              )}
                          </header>
                          {reviewVersion && scenarioMenuUpdates.has(selectedScenario!.id) && (
                            <div className="scenario-revision-note">
                              В этом сценарии есть изменения после прошлого ревью.{' '}
                              <button onClick={() => showScenarioUpdates(selectedScenario!.id)}>
                                Показать исправления →
                              </button>
                            </div>
                          )}
                          <Sequence
                            key={scenario.id}
                            description={
                              <details
                                className="scenario-description"
                                key={`${session.id}:${scenario.id}`}
                              >
                                <summary>Описание сценария</summary>
                                <ScenarioDescription
                                  summary={scenario.summary}
                                  change={
                                    reviewVersion
                                      ? undefined
                                      : scenarioUpdates.get(selectedScenario!.id)
                                  }
                                />
                              </details>
                            }
                            scenario={scenario}
                            revisionChange={
                              reviewVersion ? undefined : scenarioUpdates.get(selectedScenario!.id)
                            }
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
                      ) : (
                        <Empty title="Сценарии не восстановлены">
                          Связи появятся, если модель найдёт достаточно данных в подключённых
                          репозиториях.
                        </Empty>
                      )}
                    </>
                  )}
                  {tab === 'contracts' && (
                    <>
                      {contracts.length > 0 && (
                        <div className="section-heading">
                          <select
                            value={contract?.id ?? ''}
                            onChange={(e) => setContractId(e.target.value)}
                          >
                            {contracts.map((c) => (
                              <option value={c.id} key={c.id}>
                                {c.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {contract ? (
                        <>
                          <div className="panel">
                            <div className="card-top">
                              <h3>{contract.title}</h3>
                              <Badge value={contract.reconstructed ? 'inferred' : 'extracted'} />
                            </div>
                            <p>{contract.path}</p>
                            {contract.error && <p className="error-text">{contract.error}</p>}
                            <ul className="changes-list">
                              {contract.changes.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                            {evidenceLinks(contract.evidence)}
                          </div>
                          <ContractViewer contract={contract} />
                        </>
                      ) : (
                        <Empty title="Изменённых OpenAPI-контрактов нет">
                          Отображаются спецификации OpenAPI / Swagger в JSON и YAML, присутствующие
                          в diff.
                        </Empty>
                      )}
                    </>
                  )}
                  {tab === 'database' && (
                    <DatabaseSchemaView
                      sessionId={sessionData!.id}
                      snapshots={session.snapshots}
                      onSource={(ref) => {
                        void openSource(ref);
                      }}
                    />
                  )}
                  {tab === 'tests' && (
                    <TestsView
                      tests={result?.tests ?? []}
                      scenarios={result?.scenarios ?? []}
                      indexes={result?.indexes ?? []}
                      snapshots={session.snapshots}
                      ready={
                        result?.testAnalysisVersion === 'codex-tests-1' &&
                        !missingTestMethods(session.snapshots, result.indexes, result.tests ?? [])
                          .length
                      }
                      running={liveRun?.state === 'running'}
                      canAnalyze={!reviewVersion}
                      onAnalyze={async () => {
                        await api(`/sessions/${sessionData!.id}/test-analysis`, 'POST', {});
                        const updated = await api<ReviewSession>(`/sessions/${sessionData!.id}`);
                        if (liveSession.current === updated.id) setSession(updated);
                      }}
                      onSource={(ref) => {
                        void openSource(ref);
                      }}
                    />
                  )}
                </>
              )}
              {tab === 'review' && (
                <>
                  <ChangedFilesMenu
                    key={session.snapshots.map((snapshot) => snapshot.id).join(',')}
                    snapshots={session.snapshots}
                    snapshot={currentSnapshot}
                    selectedPath={selectedPath}
                    isViewed={fileViews.isViewed}
                    isViewPending={fileViews.isPending}
                    viewLoading={fileViews.loading}
                    onViewed={(snapshot, path, viewed) =>
                      void fileViews.setViewed(snapshot, path, viewed)
                    }
                    onSelect={(id, path) => {
                      const snapshot = session.snapshots.find((item) => item.id === id);
                      if (snapshot)
                        void openSource({
                          repoId: snapshot.repoId,
                          path,
                          side: snapshot.headFiles.includes(path) ? 'head' : 'base',
                          startLine: 1,
                          endLine: 1,
                        });
                    }}
                  />
                  <div className="inline-review-toolbar">
                    <span>{currentSnapshot?.repoName}</span>
                    <div className="review-controls">
                      {currentDraft && (
                        <button onClick={() => setDraftDialog(true)}>
                          Черновик ·{' '}
                          {currentDraft.comments.filter((comment) => comment.selected).length}
                        </button>
                      )}
                      <button
                        disabled={!!busy || !dirty}
                        onClick={() =>
                          void task('Сохраняем', async () => {
                            await saveDrafts();
                            setNotice('Черновики сохранены.');
                          })
                        }
                      >
                        {dirty ? '● Сохранить черновики' : '✓ Сохранено'}
                      </button>
                    </div>
                  </div>
                  <section
                    className="inline-source-panel"
                    aria-label="Область ревью кода"
                    onKeyDownCapture={sourceKeyboard}
                  >
                    {source ? (
                      renderSourcePanel()
                    ) : (
                      <div className="inline-review-empty">
                        {busy ? 'Загружаем код…' : 'Выберите файл в дереве проекта'}
                      </div>
                    )}
                  </section>
                  {currentDraft && draftDialog && (
                    <div className="modal-backdrop" onClick={() => setDraftDialog(false)}>
                      <section
                        className="modal review-draft-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Черновик ревью"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="section-heading">
                          <h2>Черновик ревью</h2>
                          <button
                            autoFocus
                            onClick={() => setDraftDialog(false)}
                            aria-label="Закрыть черновик"
                          >
                            ×
                          </button>
                        </div>
                        <fieldset className="draft-panel" disabled={!!reviewVersion}>
                          <div className="section-heading">
                            <span>
                              {currentDraft.comments.filter((c) => c.selected).length} выбранных
                              комментариев
                            </span>
                          </div>
                          {currentDraft.state === 'submitted' ? (
                            <div className="submission-success">
                              ✓ Ревью опубликовано.{' '}
                              <a
                                href={currentDraft.submission?.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Открыть в GitHub ↗
                              </a>
                            </div>
                          ) : currentDraft.state === 'uncertain' ||
                            currentDraft.state === 'submitting' ? (
                            <div className="unknowns">
                              <p>
                                Результат отправки неизвестен. Повторная публикация заблокирована,
                                чтобы не создать дубликат.
                              </p>
                              <button
                                onClick={() =>
                                  void task('Сверяем с GitHub', async () => {
                                    const d = await api<ReviewDraft>(
                                      `/sessions/${session.id}/drafts/${currentDraft.snapshotId}/reconcile`,
                                      'POST',
                                      {},
                                    );
                                    setDrafts((ds) =>
                                      ds.map((x) => (x.snapshotId === d.snapshotId ? d : x)),
                                    );
                                    if (d.state !== 'submitted')
                                      setNotice(
                                        'Отправленное ревью пока не найдено. Проверьте GitHub и выполните сверку позже.',
                                      );
                                  })
                                }
                              >
                                Сверить с GitHub
                              </button>
                            </div>
                          ) : (
                            <>
                              <div className="draft-comments">
                                {currentDraft.comments.map((c) => (
                                  <article key={c.id}>
                                    <div className="card-top">
                                      <label>
                                        <input
                                          type="checkbox"
                                          checked={c.selected}
                                          onChange={(e) =>
                                            updateDraft({
                                              ...currentDraft,
                                              comments: currentDraft.comments.map((x) =>
                                                x.id === c.id
                                                  ? { ...x, selected: e.target.checked }
                                                  : x,
                                              ),
                                            })
                                          }
                                        />{' '}
                                        Включить в ревью
                                      </label>
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          updateDraft({
                                            ...currentDraft,
                                            comments: currentDraft.comments.filter(
                                              (x) => x.id !== c.id,
                                            ),
                                          })
                                        }
                                      >
                                        Удалить
                                      </button>
                                    </div>
                                    <textarea
                                      aria-label="Текст комментария"
                                      value={c.body}
                                      onChange={(e) =>
                                        updateDraft({
                                          ...currentDraft,
                                          comments: currentDraft.comments.map((x) =>
                                            x.id === c.id ? { ...x, body: e.target.value } : x,
                                          ),
                                        })
                                      }
                                    />
                                    {c.evidence ? (
                                      evidenceLinks([c.evidence])
                                    ) : (
                                      <small>Общий комментарий</small>
                                    )}
                                    <span className="comment-location">
                                      {commentLocation(currentSnapshot!, c.evidence)}
                                    </span>
                                  </article>
                                ))}
                              </div>
                              <div className="draft-footer">
                                <select
                                  aria-label="Решение по PR"
                                  value={currentDraft.action}
                                  onChange={(e) =>
                                    updateDraft({
                                      ...currentDraft,
                                      action: e.target.value as ReviewDraft['action'],
                                    })
                                  }
                                >
                                  <option value="COMMENT">Comment — оставить комментарии</option>
                                  <option value="REQUEST_CHANGES">
                                    Request changes — запросить изменения
                                  </option>
                                  <option value="APPROVE">Approve — одобрить PR</option>
                                </select>
                                <button
                                  className="primary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    void task('Готовим ревью', async () => {
                                      const saved = await saveDrafts();
                                      setDraftDialog(false);
                                      setPreview(
                                        saved?.find(
                                          (d) => d.snapshotId === currentDraft.snapshotId,
                                        ) ?? currentDraft,
                                      );
                                    })
                                  }
                                >
                                  Проверить и отправить ↗
                                </button>
                              </div>
                            </>
                          )}
                        </fieldset>
                      </section>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {busy && (
            <div className="busy-toast" role="status">
              <span className="spinner" />
              {busy}…
            </div>
          )}
          {!busy && analysisToast && (
            <div className="busy-toast analysis-toast" role="status" aria-live="polite">
              <span>{analysisToast.text}</span>
              <button aria-label="Закрыть уведомление" onClick={() => setAnalysisToast(null)}>
                ×
              </button>
            </div>
          )}
        </div>
        <footer className="page-footer">
          <span>REVIEW / FREE SOLO LAB</span>
          <span>Решение остаётся за вами.</span>
        </footer>
      </main>
      {setup && (
        <Setup
          repos={repos}
          onClose={() => setSetup(false)}
          onError={setError}
          onCreated={async (s) => {
            await refreshLists();
            await load(s.id);
            setSetup(false);
            setTab('overview');
          }}
          onRepo={(r) => setRepos((old) => (old.some((x) => x.id === r.id) ? old : [...old, r]))}
        />
      )}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setDeleteTarget(null);
          }}
        >
          <section
            className="modal delete-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-review-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-review-title">Удалить сохранённое ревью?</h2>
            <p>
              <strong>{deleteTarget.title}</strong>
            </p>
            <p>
              Будут удалены локальный анализ, история версий, черновики и снимки кода этого ревью.
              Отменить удаление нельзя. PR и опубликованные комментарии в GitHub сохранятся.
            </p>
            {deleteTarget.id === sessionData?.id && dirty && (
              <p>Несохранённые изменения черновика тоже будут удалены.</p>
            )}
            {error && (
              <p className="alert error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button autoFocus disabled={!!busy} onClick={() => setDeleteTarget(null)}>
                Отмена
              </button>
              <button
                className="danger-button"
                disabled={!!busy}
                onClick={() =>
                  void task('Удаляем сохранённое ревью', async () => {
                    const removed = await api<{ ok: boolean; warnings: string[] }>(
                      `/sessions/${deleteTarget.id}`,
                      'DELETE',
                      {},
                    );
                    try {
                      clearDraftCache(deleteTarget.id);
                    } catch {
                      /* Deletion on server succeeded. */
                    }
                    if (sessionData?.id === deleteTarget.id) {
                      liveSession.current = null;
                      setSession(null);
                      setDrafts([]);
                      setDirty(false);
                      setRevisionId('');
                      setSource(null);
                      setSourceNavigation({ back: [], forward: [] });
                      setDefinitionPicker(null);
                      setPreview(null);
                      setTab('overview');
                    }
                    setDeleteTarget(null);
                    await refreshLists();
                    setNotice(
                      removed.warnings.length
                        ? `Ревью удалено. ${removed.warnings.join(' ')}`
                        : 'Сохранённое ревью удалено.',
                    );
                    window.setTimeout(() => setNotice(''), 5000);
                  })
                }
              >
                Удалить ревью
              </button>
            </div>
          </section>
        </div>
      )}
      {sqlTarget && sessionData && (
        <SqlQueryDrawer
          sessionId={sessionData.id}
          evidence={sqlTarget.evidence}
          snapshotId={sqlTarget.snapshotId}
          analysisKey={`${liveRun?.id}:${liveRun?.state}`}
          analyzing={liveRun?.state === 'running'}
          canGenerate={
            sessionData.snapshots.some((snapshot) => snapshot.id === sqlTarget.snapshotId) &&
            (liveRun?.result.sqlAnalysisVersion !== 'codex-sql-1' ||
              (!!liveRun &&
                missingSqlMethods(
                  sessionData.snapshots,
                  liveRun.result.indexes,
                  liveRun.result.database,
                ).length > 0))
          }
          onGenerate={async () => {
            await api(`/sessions/${sessionData.id}/sql-analysis`, 'POST', {});
            const updated = await api<ReviewSession>(`/sessions/${sessionData.id}`);
            if (liveSession.current === sessionData.id) setSession(updated);
          }}
          onClose={() => setSqlTarget(null)}
          onCode={() => {
            setSqlTarget(null);
            void openSource(sqlTarget.evidence, sqlTarget.versionId);
          }}
        />
      )}
      {source && tab !== 'review' && (
        <div className="drawer-backdrop" onClick={() => setSource(null)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Исходный код"
            className="source-drawer"
            onKeyDownCapture={sourceKeyboard}
            onClick={(e) => e.stopPropagation()}
          >
            {renderSourcePanel()}
          </aside>
        </div>
      )}
      {preview && session && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Публикация ревью"
            className="modal review-preview"
          >
            <div className="section-heading">
              <h2>Публикация ревью</h2>
              <button onClick={() => setPreview(null)}>×</button>
            </div>
            <p>
              Ревью будет отправлено от имени <strong>{status?.login ?? 'пользователя gh'}</strong>{' '}
              для коммита <code>{preview.headSha.slice(0, 7)}</code>.
            </p>
            <div className="preview-action">{preview.action}</div>
            {session.run?.state === 'partial' && (
              <div className="unknowns">
                Анализ частичный. Проверьте раздел «Неизвестное и ограничения» перед принятием
                решения.
              </div>
            )}
            <p className="preserve">{preview.body || 'Без общего комментария'}</p>
            {preview.comments
              .filter((c) => c.selected)
              .map((c) => (
                <div className="preview-comment" key={c.id}>
                  <small>
                    {commentLocation(
                      session.snapshots.find((s) => s.id === preview.snapshotId)!,
                      c.evidence,
                    )}
                  </small>
                  <p>{c.body}</p>
                </div>
              ))}
            <div className="draft-footer">
              <button onClick={() => setPreview(null)}>Вернуться к редактированию</button>
              <button
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  void task('Отправляем ревью', async () => {
                    try {
                      const d = await api<ReviewDraft>(
                        `/sessions/${session.id}/drafts/${preview.snapshotId}/submit`,
                        'POST',
                        {},
                      );
                      setDrafts((ds) => ds.map((x) => (x.snapshotId === d.snapshotId ? d : x)));
                      setNotice('Ревью опубликовано в GitHub.');
                    } finally {
                      setPreview(null);
                      const ds = await api<ReviewDraft[]>(`/sessions/${session.id}/drafts`);
                      setDrafts(ds);
                    }
                  })
                }
              >
                Отправить {preview.action === 'APPROVE' ? 'Approve' : 'ревью'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
