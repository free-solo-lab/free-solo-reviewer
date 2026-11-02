import { useEffect, useRef, useState } from 'react';
import type { Evidence, Snapshot } from '../shared/model';
import type { MethodView } from '../shared/viewed-methods';
import { api } from './api';

export function useViewedMethods(
  sessionId: string | undefined,
  snapshot: Snapshot | undefined,
  evidence: Evidence | undefined,
) {
  const context = JSON.stringify([sessionId, snapshot?.id, evidence?.path, evidence?.side]);
  const active = useRef(context);
  active.current = context;
  const [state, setState] = useState<{ context: string; methods: MethodView[] }>({
    context: '',
    methods: [],
  });
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setPending(new Set());
    setError('');
    if (
      sessionId &&
      snapshot &&
      evidence &&
      (evidence.side === 'head' ? snapshot.headFiles : snapshot.baseFiles).includes(evidence.path)
    ) {
      const params = new URLSearchParams({
        snapshotId: snapshot.id,
        path: evidence.path,
        side: evidence.side,
      });
      api<MethodView[]>(`/sessions/${sessionId}/viewed-methods?${params}`)
        .then((methods) => {
          if (!cancelled) setState({ context, methods });
        })
        .catch(() => {
          if (!cancelled) setError('Не удалось загрузить отметки методов.');
        });
    }
    return () => {
      cancelled = true;
    };
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
      if (active.current === context) {
        setState((previous) => ({
          context,
          methods: previous.methods.map((method) => (method.key === entry.key ? updated : method)),
        }));
        setError('');
      }
    } catch {
      if (active.current === context) setError('Не удалось сохранить отметку метода.');
    } finally {
      if (active.current === context)
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(entry.key);
          return next;
        });
    }
  };
  return { methods: state.context === context ? state.methods : [], pending, error, setViewed };
}
