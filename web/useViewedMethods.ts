import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Evidence, Snapshot } from '../shared/model';
import type { MethodView } from '../shared/viewed-methods';
import { api } from './api';
import { t } from '../shared/i18n';

/** One file's method marks; every view of that file shares this cache entry. */
const methodsQuery = (sessionId: string, snapshot: Snapshot, evidence: Evidence) => ({
  queryKey: [
    'viewed-methods',
    JSON.stringify([sessionId, snapshot.id, evidence.path, evidence.side]),
  ] as const,
  queryFn: () =>
    api<MethodView[]>(
      `/sessions/${sessionId}/viewed-methods?${new URLSearchParams({ snapshotId: snapshot.id, path: evidence.path, side: evidence.side })}`,
    ),
});
const markable = (snapshot: Snapshot | undefined, evidence: Evidence | undefined) =>
  !!(
    snapshot &&
    evidence &&
    (evidence.side === 'head' ? snapshot.headFiles : snapshot.baseFiles).includes(evidence.path)
  );
const saveMark = (
  sessionId: string,
  snapshot: Snapshot,
  evidence: Evidence,
  line: number,
  viewed: boolean,
) =>
  api<MethodView>(`/sessions/${sessionId}/viewed-methods`, 'PUT', {
    snapshotId: snapshot.id,
    path: evidence.path,
    side: evidence.side,
    line,
    viewed,
  });

/** All code views of the same method share its review state. */
export function useViewedMethods(
  sessionId: string | undefined,
  snapshot: Snapshot | undefined,
  evidence: Evidence | undefined,
) {
  const client = useQueryClient();
  const context = JSON.stringify([sessionId, snapshot?.id, evidence?.path, evidence?.side]);
  const active = useRef(context);
  active.current = context;
  const key = ['viewed-methods', context];
  const enabled = !!sessionId && markable(snapshot, evidence);
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: () => methodsQuery(sessionId!, snapshot!, evidence!).queryFn(),
  });
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    setPending(new Set());
    setError('');
  }, [context]);
  const setViewed = async (entry: MethodView, viewed: boolean) => {
    if (!sessionId || !snapshot || !evidence) return;
    setPending((previous) => new Set(previous).add(entry.key));
    try {
      const updated = await saveMark(
        sessionId,
        snapshot,
        evidence,
        entry.method.evidence.startLine,
        viewed,
      );
      client.setQueryData<MethodView[]>(key, (previous) =>
        previous?.map((method) => (method.key === entry.key ? updated : method)),
      );
      if (active.current === context) setError('');
    } catch {
      if (active.current === context) setError(t('Could not save the method mark.'));
    } finally {
      if (active.current === context)
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(entry.key);
          return next;
        });
    }
  };
  return {
    methods: enabled ? (query.data ?? []) : [],
    pending,
    error: error || (query.error ? t('Could not load method marks.') : ''),
    setViewed,
  };
}

/**
 * The marks of a group of methods, e.g. every method of a scenario, read and set at once. A
 * method is identified by its file and first line, as in the code views.
 */
export function useViewedMethodGroup(
  sessionId: string | undefined,
  targets: { snapshot: Snapshot; evidence: Evidence }[],
) {
  const client = useQueryClient();
  const files = new Map<string, { snapshot: Snapshot; evidence: Evidence }>();
  for (const target of targets)
    if (sessionId && markable(target.snapshot, target.evidence))
      files.set(methodsQuery(sessionId, target.snapshot, target.evidence).queryKey[1], target);
  const queries = useQueries({
    queries: [...files.values()].map(({ snapshot, evidence }) =>
      methodsQuery(sessionId!, snapshot, evidence),
    ),
  });
  const marks = new Map([...files.keys()].map((file, i) => [file, queries[i]?.data]));
  const methods = targets.flatMap((target) => {
    if (!sessionId) return [];
    const file = methodsQuery(sessionId, target.snapshot, target.evidence).queryKey[1];
    const view = marks
      .get(file)
      ?.find((item) => item.method.evidence.startLine === target.evidence.startLine);
    return view ? [{ ...target, file, view }] : [];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const setViewed = async (viewed: boolean) => {
    if (!sessionId) return;
    setSaving(true);
    setError('');
    const changes = methods.filter((item) => item.view.viewed !== viewed);
    const results = await Promise.allSettled(
      changes.map(async ({ snapshot, evidence, file, view }) => {
        const updated = await saveMark(
          sessionId,
          snapshot,
          evidence,
          view.method.evidence.startLine,
          viewed,
        );
        client.setQueryData<MethodView[]>(['viewed-methods', file], (previous) =>
          previous?.map((method) => (method.key === updated.key ? updated : method)),
        );
      }),
    );
    if (results.some((result) => result.status === 'rejected'))
      setError(t('Could not save the method mark.'));
    setSaving(false);
  };
  return {
    total: methods.length,
    viewed: methods.filter((item) => item.view.viewed).length,
    loading: queries.some((query) => query.isPending),
    saving,
    error: error || (queries.some((query) => query.error) ? t('Could not load method marks.') : ''),
    setViewed,
  };
}
