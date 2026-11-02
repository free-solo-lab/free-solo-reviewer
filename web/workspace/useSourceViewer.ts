import type React from 'react';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type {
  Evidence,
  ReviewDraft,
  ReviewRevision,
  ReviewSession,
  Snapshot,
  SourceIndex,
} from '../../shared/model';
import {
  evidenceMethodLink,
  methodLinks,
  needsDefinitionPicker,
  type MethodLink,
} from '../../shared/code-navigation';
import { sourceDiscussions } from '../../shared/discussion-threads';
import { reviewDiffRows } from '../../shared/source-diff';
import type { CodeComparison } from '../../shared/code-comparison';
import { api } from '../api';
import { loadNavigationIndex, loadSnapshotSource } from '../sessions';
import { useReviewDiscussion } from '../useReviewDiscussion';
import { useViewedFiles } from '../useViewedFiles';
import { useViewedMethods } from '../useViewedMethods';
import type { Tab } from './tabs';
import { reviewDraftsWithHistory } from '../../shared/review-history';
import { t } from '../../shared/i18n';
import { reviewSnapshotId, reviewContext } from '../../shared/review-timeline';

export type SourcePage = {
  navigationIndex?: SourceIndex;
  comparison?: CodeComparison;
  versionId?: string;
  selection?: Evidence;
  evidence: Evidence;
  text: string;
  visitId: number;
  position?: { top: number; left: number };
};
export type SourceVisit = {
  page: SourcePage;
  comment: string;
  /** The interface-or-implementation choice open on that page, shown again on return. */
  picker?: MethodLink | null;
  position: { top: number; left: number };
};

/** The open source file: navigation between definitions and versions, comments and threads. */
export function useSourceViewer({
  session,
  sessionData,
  reviewVersion,
  liveSession,
  drafts,
  tab,
  task,
  setRevisionId,
  onFile,
  shared,
}: {
  session: ReviewSession | null;
  sessionData: ReviewSession | null;
  reviewVersion: ReviewRevision | undefined;
  liveSession: MutableRefObject<string | null>;
  drafts: ReviewDraft[];
  tab: Tab;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  setRevisionId: (id: string) => void;
  /** Keeps the file tree on the file being read. */
  onFile: (snapshotId: string, path: string) => void;
  shared?: {
    fileViews: ReturnType<typeof useViewedFiles>;
    reviewDiscussion: ReturnType<typeof useReviewDiscussion>;
  };
}) {
  const [source, setSource] = useState<SourcePage | null>(null),
    [comment, setComment] = useState(''),
    [sourceComparisonId, setSourceComparisonId] = useState('');
  const [sourceNavigation, setSourceNavigation] = useState<{
    back: SourceVisit[];
    forward: SourceVisit[];
  }>({ back: [], forward: [] });
  const [definitionPicker, setDefinitionPicker] = useState<MethodLink | null>(null);
  const previousCodeTab = useRef(tab);
  useEffect(() => {
    if (
      (previousCodeTab.current === 'review' || previousCodeTab.current === 'contracts') &&
      previousCodeTab.current !== tab
    )
      setSource(null);
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
  const sourceVersion = session?.snapshots.map((snapshot) => snapshot.id).join(',') ?? '';
  const liveSourceVersion = useRef(sourceVersion);
  liveSourceVersion.current = sourceVersion;
  useEffect(() => {
    setSource(sourceRestore.current?.version === sourceVersion ? sourceRestore.current.page : null);
    sourceRestore.current = null;
    setSourceNavigation({ back: [], forward: [] });
    setDefinitionPicker(null);
  }, [sourceVersion]);
  function resetSource() {
    setSource(null);
    setSourceComparisonId('');
    setSourceNavigation({ back: [], forward: [] });
    setDefinitionPicker(null);
  }
  function syncSourceFile(evidence: Evidence, snapshots: Snapshot[]) {
    const snapshot = snapshots.find((item) => item.repoId === evidence.repoId);
    if (!snapshot) return;
    const changed = snapshot.files.find((item) =>
      evidence.side === 'base'
        ? (item.oldPath ?? item.path) === evidence.path
        : item.path === evidence.path,
    );
    onFile(snapshot.id, changed?.path ?? evidence.path);
  }
  async function openSource(evidence: Evidence, versionId = reviewVersion?.id ?? 'current') {
    const rangeSnapshot =
      versionId === 'current'
        ? session?.snapshots.find((s) => s.repoId === evidence.repoId)
        : undefined;
    // Removed-only files belong to the saved review, not to the PR's original base lines.
    if (evidence.side === 'base' && rangeSnapshot?.reviewBase)
      return openSource({ ...evidence, side: 'head' }, rangeSnapshot.reviewBase.revisionId);
    const request = ++sourceRequest.current;
    // Opening another place keeps the one left behind, so Back returns to it.
    const visit = captureVisit();
    await task(t('Opening code'), async () => {
      if (!session) return;
      const version = sourceVersion;
      const context =
        versionId === (reviewVersion?.id ?? 'current')
          ? session
          : versionId === 'current'
            ? sessionData
            : reviewContext(sessionData, versionId);
      const snapshot = context?.snapshots.find((snapshot) => snapshot.repoId === evidence.repoId);
      if (!snapshot) throw new Error(t('The snapshot of this version was not found.'));
      const navigationIndex = /\.(java|kt)$/.test(evidence.path)
        ? await loadNavigationIndex(session.id, snapshot.id, evidence.side)
        : undefined;
      let comparison =
        sourceComparisonId && versionId === 'current' && evidence.side === 'head'
          ? await api<CodeComparison>(
              `/sessions/${session.id}/code-comparison?${new URLSearchParams({ repoId: evidence.repoId, path: evidence.path, revisionId: sourceComparisonId })}`,
            )
          : undefined;
      const { text } = comparison ?? (await loadSnapshotSource(session.id, snapshot.id, evidence));
      if (!comparison && snapshot.reviewBase && evidence.side === 'head') {
        const file = snapshot.files.find(
          (f) => f.path === evidence.path || f.oldPath === evidence.path,
        );
        comparison = {
          previousRevisionId: snapshot.reviewBase.revisionId,
          previousSnapshotId: snapshot.reviewBase.snapshotId,
          previousSha: snapshot.mergeBase,
          currentSnapshotId: reviewSnapshotId(snapshot),
          currentSha: snapshot.headSha,
          previousPath: file?.oldPath ?? file?.path ?? evidence.path,
          path: file?.path ?? evidence.path,
          text,
          file: file ?? {
            path: evidence.path,
            status: 'unchanged',
            patch: '',
            addedLines: [],
            removedLines: [],
          },
        };
      }
      if (comparison) evidence = { ...evidence, path: comparison.path };
      if (
        request !== sourceRequest.current ||
        liveSession.current !== session.id ||
        liveSourceVersion.current !== version
      )
        return;
      syncSourceFile(evidence, context!.snapshots);
      setSource({
        evidence,
        text,
        versionId,
        comparison,
        navigationIndex,
        visitId: ++sourceSerial.current,
      });
      const left = visit?.page.evidence;
      if (
        visit &&
        activeSource.current?.visitId === visit.page.visitId &&
        (left?.repoId !== evidence.repoId ||
          left.path !== evidence.path ||
          left.side !== evidence.side ||
          left.startLine !== evidence.startLine ||
          visit.page.versionId !== versionId)
      ) {
        visit.comment = sourceComment.current;
        setSourceNavigation((previous) => ({ back: [...previous.back, visit], forward: [] }));
      } else setSourceNavigation((previous) => ({ ...previous, forward: [] }));
      setDefinitionPicker(
        evidenceMethodLink(
          evidence,
          navigationIndex ? [navigationIndex] : (context?.run?.result.indexes ?? []),
        ),
      );
      setComment('');
    });
  }
  const sourceSelection = source?.selection ?? source?.evidence;
  const sourceContext =
    source?.versionId === (reviewVersion?.id ?? 'current')
      ? session
      : source?.versionId === 'current'
        ? sessionData
        : (reviewContext(sessionData, source?.versionId ?? '') ?? session);
  const sourceSnapshot = sourceContext?.snapshots.find(
    (snapshot) => snapshot.repoId === source?.evidence.repoId,
  );
  const ownFileViews = useViewedFiles(shared ? undefined : sessionData?.id, [
    ...(session?.snapshots ?? []),
    ...(sessionData?.snapshots ?? []),
    ...(sourceSnapshot ? [sourceSnapshot] : []),
  ]);
  const methodViews = useViewedMethods(sessionData?.id, sourceSnapshot, source?.evidence);
  const ownDiscussion = useReviewDiscussion(
    shared ? undefined : sessionData?.id,
    sessionData?.update?.id,
    sessionData?.threadDiscussion ?? sessionData?.discussion ?? [],
    sessionData?.discussionRevision,
  );
  const fileViews = shared?.fileViews ?? ownFileViews;
  const reviewDiscussion = shared?.reviewDiscussion ?? ownDiscussion;
  const allDrafts = [
    ...drafts,
    ...(sessionData?.history ?? []).flatMap((revision) => revision.drafts),
  ];
  const sourceThreads =
    source && sourceSnapshot
      ? sourceDiscussions(
          reviewDiscussion.comments,
          sourceSnapshot,
          source.evidence,
          sourceSnapshot.headSha ===
            sessionData?.snapshots.find((snapshot) => snapshot.repoId === sourceSnapshot.repoId)
              ?.headSha,
          allDrafts,
        )
      : [];
  const sourcePreviousRevision = reviewContext(
    sessionData,
    source?.comparison?.previousRevisionId ?? '',
  );
  const sourcePreviousSnapshot = sourcePreviousRevision?.snapshots.find(
    (snapshot) => snapshot.id === source?.comparison?.previousSnapshotId,
  );
  const sourcePreviousDrafts = (sourcePreviousRevision?.drafts ?? [])
    .flatMap(reviewDraftsWithHistory)
    .filter((draft) => draft.snapshotId === sourcePreviousSnapshot?.id);
  const sourcePreviousThreads =
    source && sourcePreviousSnapshot
      ? sourceDiscussions(
          reviewDiscussion.comments,
          sourcePreviousSnapshot,
          { ...source.evidence, path: source.comparison!.previousPath, side: 'head' },
          false,
          allDrafts,
        )
      : [];
  const sourceReadOnly =
    source?.versionId !== 'current' ||
    !(sourceSnapshot?.pr || sourceSnapshot?.local) ||
    !drafts.some(
      (draft) => draft.snapshotId === reviewSnapshotId(sourceSnapshot) && draft.state === 'draft',
    );
  const sourceDrafts =
    source?.versionId === 'current'
      ? drafts
      : (reviewContext(sessionData, source?.versionId ?? '')?.drafts ?? []);
  const sourceComments = sourceDrafts
    .flatMap(reviewDraftsWithHistory)
    .filter(
      (draft) =>
        draft.snapshotId === (sourceSnapshot && reviewSnapshotId(sourceSnapshot)) &&
        draft.headSha === sourceSnapshot?.headSha,
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
        ? methodLinks(
            source.text,
            source.evidence,
            source.navigationIndex
              ? [source.navigationIndex]
              : (sourceContext?.run?.result.indexes ?? []),
          )
        : [],
    [
      source?.text,
      source?.evidence.repoId,
      source?.evidence.side,
      source?.evidence.path,
      sourceContext,
      source?.navigationIndex,
    ],
  );
  function captureVisit(page = source): SourceVisit | null {
    return page
      ? {
          page,
          comment: sourceComment.current,
          picker: definitionPicker,
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
    await task(t('Opening the definition'), async () => {
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
        navigationIndex: origin.navigationIndex,
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
      target.page.versionId === (reviewVersion?.id ?? 'current')
        ? session
        : target.page.versionId === 'current'
          ? sessionData
          : reviewContext(sessionData, target.page.versionId ?? '');
    if (context) syncSourceFile(target.page.evidence, context.snapshots);
    setSource({ ...target.page, position: target.position, visitId: ++sourceSerial.current });
    setComment(target.comment);
    setDefinitionPicker(target.picker ?? null);
  }
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
    await task(t('Comparing code'), async () => {
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
      const navigationIndex = await loadNavigationIndex(
        sessionId,
        sessionData.snapshots.find((s) => s.repoId === origin.evidence.repoId)!.id,
        'head',
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
        navigationIndex,
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
    await task(t('Opening the code of the previous review'), async () => {
      const { text } = await api<{ text: string }>(
        `/sessions/${sessionId}/source?${new URLSearchParams({ repoId: evidence.repoId, side: 'head', path: evidence.path, snapshotId: comparison.previousSnapshotId })}`,
      );
      const navigationIndex = await loadNavigationIndex(
        sessionId,
        comparison.previousSnapshotId,
        evidence.side,
      );
      if (liveSession.current !== sessionId || activeSource.current?.visitId !== origin.visitId)
        return;
      setSourceNavigation((previous) => ({ back: [...previous.back, visit], forward: [] }));
      setSource({
        navigationIndex,
        evidence,
        text,
        versionId: comparison.previousRevisionId,
        visitId: ++sourceSerial.current,
      });
      setComment('');
      setDefinitionPicker(null);
    });
  }
  return {
    source,
    setSource,
    comment,
    setComment,
    sourceNavigation,
    definitionPicker,
    setDefinitionPicker,
    sourceViewport,
    sourceComment,
    sourceVersion,
    resetSource,
    openSource,
    sourceSelection,
    sourceContext,
    sourceSnapshot,
    fileViews,
    methodViews,
    reviewDiscussion,
    sourceThreads,
    sourcePreviousDrafts,
    sourcePreviousThreads,
    sourceReadOnly,
    sourceComments,
    sourceChangedFile,
    codeLinks,
    navigateDefinition,
    followDefinition,
    sourceBack,
    sourceKeyboard,
    changeSourceComparison,
    sourceComparisonId,
    setSourceComparisonId,
    navigatePreviousCode,
  };
}
