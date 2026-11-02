import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProgressEvent, ReviewSession, ReviewRevision, SourceIndex } from '../../shared/model';
import { fetchSession, resultIndexes } from '../sessions';
import { t } from '../../shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryClient, queryKeys } from '../queries';
import {
  selectedReviewRange,
  reviewRevisionForPoint,
  type ReviewRangeComparison,
} from '../../shared/review-timeline';

/** Stable, so memoized comparisons are not rebuilt on every render while indexes load. */
const NO_INDEXES: SourceIndex[] = [];

/** The open review, the version shown and the analysis that streams into it. */
export function useLiveSession(
  revisionId: string,
  setError: (message: string) => void,
  onFinished: () => void,
  comparisonFrom = '',
) {
  const [sessionData, setSession] = useState<ReviewSession | null>(null);
  const remoteSession = useRef<string | undefined>(undefined);
  remoteSession.current = sessionData?.id;
  useEffect(() => {
    const id = sessionData?.id;
    if (!id) return;
    let active = true,
      loading = false;
    const sync = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        let updated = await api<ReviewSession>(`/sessions/${id}/remote-state`);
        if (
          updated.snapshots.map((s) => s.pr?.number ?? '').join(',') !==
          sessionData.snapshots.map((s) => s.pr?.number ?? '').join(',')
        )
          void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
        if (
          updated.snapshots.map((s) => s.id).join(',') !==
          sessionData.snapshots.map((s) => s.id).join(',')
        )
          updated = await fetchSession(id);
        if (active && remoteSession.current === id)
          setSession((current) =>
            current?.id === id
              ? {
                  ...current,
                  ...(updated.snapshots.map((s) => s.id).join(',') !==
                  current.snapshots.map((s) => s.id).join(',')
                    ? updated
                    : {}),
                  snapshots: updated.snapshots,
                  workflow: updated.workflow,
                  threadDiscussion: updated.threadDiscussion,
                  discussionRevision: updated.discussionRevision,
                }
              : current,
          );
      } catch {
        /* Saved code and discussions remain available offline. */
      } finally {
        loading = false;
      }
    };
    void sync();
    const focus = () => void sync();
    window.addEventListener('focus', focus);
    const timer = window.setInterval(focus, 60000);
    return () => {
      active = false;
      window.removeEventListener('focus', focus);
      window.clearInterval(timer);
    };
  }, [sessionData?.id, sessionData?.snapshots.map((s) => s.pr?.number).join(',')]);
  const reviewRange = sessionData
    ? selectedReviewRange(sessionData, comparisonFrom, revisionId)
    : undefined;
  // History supplies comparison baselines; the right side always remains the current code.
  const reviewVersion = undefined as ReviewRevision | undefined;
  const original = sessionData;
  const comparison = useQuery({
    queryKey: [
      'review-comparison',
      sessionData?.id,
      reviewRange?.from.id,
      reviewRange?.to?.id,
      reviewRange?.from.snapshots.map((s) => s.id).join(','),
      reviewRange?.to?.snapshots.map((s) => s.id).join(','),
    ],
    enabled: !!sessionData && !!reviewRange?.to,
    queryFn: () =>
      api<ReviewRangeComparison>(
        `/sessions/${sessionData!.id}/review-comparison?${new URLSearchParams({ from: reviewRange!.from.id, to: reviewRange!.to!.id })}`,
      ),
    staleTime: Infinity,
    // The server owns the lightweight comparison snapshots; recreate them after a restart.
    refetchOnMount: 'always',
  });
  useEffect(() => {
    if (comparison.error) setError(comparison.error.message);
  }, [comparison.error]);
  const rangeComparison = comparison.data;
  const previous = rangeComparison
    ? reviewRevisionForPoint(sessionData, rangeComparison.from)
    : undefined;
  const baselineResult = (
    previous ??
    sessionData?.history?.find((r) =>
      r.snapshots.some((s) => s.id === reviewRange?.from.snapshots[0]?.id),
    )
  )?.run.result;
  // Older revisions arrive without their indexes; fetch them only for the compared one.
  const baselineIndexes = useQuery({
    queryKey: ['revision-indexes', baselineResult?.indexRefs?.join(',')],
    enabled: !!baselineResult?.indexRefs,
    queryFn: () => resultIndexes(baselineResult!),
    staleTime: Infinity,
  });
  // While they load the comparison has no navigation rather than the wrong revision's.
  const before = baselineResult?.indexRefs
    ? (baselineIndexes.data ?? NO_INDEXES)
    : (baselineResult?.indexes ?? original?.run?.result.indexes);
  const baseIndexes = useMemo(() => {
    const sourceSide = rangeComparison?.from === 'base' ? 'base' : 'head';
    // Reuse this remapping while streamed events arrive; the source indexes did not change.
    return (before ?? [])
      .filter((i) => i.side === sourceSide)
      .map((index) =>
        JSON.parse(
          JSON.stringify(index, (key, value: unknown) => (key === 'side' ? 'base' : value)),
        ),
      );
  }, [before, rangeComparison?.from]);
  const comparedResult = useMemo(
    () =>
      original?.run?.result && rangeComparison
        ? {
            ...original.run.result,
            contracts: rangeComparison.contracts,
            indexes: [
              ...original.run.result.indexes.filter((i) => i.side === 'head'),
              ...baseIndexes,
            ],
          }
        : original?.run?.result,
    [original?.run?.result, rangeComparison, baseIndexes],
  );
  const comparedUpdate = useMemo(
    () =>
      rangeComparison && previous
        ? {
            id: `range:${rangeComparison.from}:${rangeComparison.to}`,
            at: previous.savedAt,
            previousReviewId: previous.id,
            discussion: [],
            gaps: [],
            changes: rangeComparison.snapshots.map((s) => ({
              repoId: s.repoId,
              fromSha: s.mergeBase,
              toSha: s.headSha,
              files: s.files,
            })),
          }
        : undefined,
    [rangeComparison, previous],
  );
  const session = useMemo(() => {
    if (!original || !rangeComparison) return original;
    return {
      ...original,
      snapshots: rangeComparison.snapshots,
      contracts: rangeComparison.contracts,
      update: comparedUpdate,
      run:
        original.run && comparedResult
          ? { ...original.run, previousReviewId: previous?.id, result: comparedResult }
          : original.run,
    };
  }, [original, rangeComparison, comparedResult, comparedUpdate]);
  const liveRun = sessionData?.run;
  const result = session?.run?.result;
  // Responses for a review that is no longer open are dropped.
  const liveSession = useRef<string | null>(null);
  liveSession.current = session?.id ?? null;
  useEffect(() => {
    if (!sessionData || liveRun?.state !== 'running') return;
    const id = sessionData.id,
      stream = new EventSource(`/api/sessions/${id}/events`);
    let refetch: number | undefined;
    const sync = () => {
      refetch = undefined;
      void fetchSession(id)
        .then((s) => {
          // Events streamed while the request was in flight stay visible.
          if (liveSession.current === id)
            setSession((current) =>
              s.run &&
              current?.run?.id === s.run.id &&
              current.run.events.length > s.run.events.length
                ? { ...s, run: { ...s.run, events: current.run.events } }
                : s,
            );
          if (s.run?.state !== 'running') {
            stream.close();
            onFinished();
          }
        })
        .catch((e) => setError(e.message));
    };
    // Codex output arrives in the event itself; only stage and usage events change the run.
    const schedule = () => {
      refetch ??= window.setTimeout(sync, 500);
    };
    stream.onopen = schedule;
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as ProgressEvent;
      setSession((current) =>
        current?.id === id && current.run && (current.run.events.at(-1)?.seq ?? 0) < event.seq
          ? { ...current, run: { ...current.run, events: [...current.run.events, event] } }
          : current,
      );
      if (!event.kind || event.kind === 'progress' || event.kind === 'usage') schedule();
    };
    return () => {
      stream.close();
      window.clearTimeout(refetch);
    };
  }, [sessionData?.id, liveRun?.id, liveRun?.state]);

  const [analysisToast, setAnalysisToast] = useState<{ runId: string; text: string } | null>(null);
  const previousAnalysis = useRef<{ sessionId: string; runId: string; state: string } | null>(null);
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
        complete: t('Analysis finished. Results are ready.'),
        partial: t('Analysis finished partially. Available results are saved.'),
        failed: t('The analysis could not finish. See the analysis log for details.'),
        cancelled: t('Analysis stopped.'),
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

  return {
    sessionData,
    setSession,
    reviewVersion,
    session,
    liveRun,
    result,
    liveSession,
    analysisToast,
    setAnalysisToast,
    reviewRange,
    rangeComparison,
    comparisonLoading: !!reviewRange?.to && comparison.isPending,
    comparisonError: comparison.error,
  };
}
