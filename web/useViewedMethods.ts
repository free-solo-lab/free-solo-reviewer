import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Evidence, Snapshot } from '../shared/model';
import type { MethodView } from '../shared/viewed-methods';
import { api } from './api';
import { t } from '../shared/i18n';

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
  const enabled = !!(
    sessionId &&
    snapshot &&
    evidence &&
    (evidence.side === 'head' ? snapshot.headFiles : snapshot.baseFiles).includes(evidence.path)
  );
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: () =>
      api<MethodView[]>(
        `/sessions/${sessionId}/viewed-methods?${new URLSearchParams({ snapshotId: snapshot!.id, path: evidence!.path, side: evidence!.side })}`,
      ),
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
      const updated = await api<MethodView>(`/sessions/${sessionId}/viewed-methods`, 'PUT', {
        snapshotId: snapshot.id,
        path: evidence.path,
        side: evidence.side,
        line: entry.method.evidence.startLine,
        viewed,
      });
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
