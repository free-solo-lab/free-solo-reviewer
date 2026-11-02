import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../shared/model';
import { reviewFilePath, type FileViewStatus } from '../shared/viewed-files';
import { api } from './api';
import { errorMessage } from '../shared/errors';
import { t } from '../shared/i18n';
const key = (snapshot: Snapshot, path: string) =>
  JSON.stringify([snapshot.id, reviewFilePath(snapshot, path)]);
export function useViewedFiles(sessionId: string | undefined, snapshots: Snapshot[]) {
  const snapshotIds = [...new Set(snapshots.map((snapshot) => snapshot.id))].sort().join(',');
  const context = `${sessionId}:${snapshotIds}`,
    active = useRef(context);
  active.current = context;
  const request = useRef(0),
    [statuses, setStatuses] = useState<Set<string>>(new Set()),
    [pending, setPending] = useState<Set<string>>(new Set()),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const reload = useCallback(async () => {
    const serial = ++request.current;
    if (!sessionId || !snapshotIds) {
      setStatuses(new Set());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const values = await api<FileViewStatus[]>(
        `/sessions/${sessionId}/viewed-files?${new URLSearchParams({ snapshotIds })}`,
      );
      if (active.current === context && serial === request.current) {
        setStatuses(
          new Set(
            values
              .filter((value) => value.viewed)
              .map((value) => JSON.stringify([value.snapshotId, value.path])),
          ),
        );
        setError('');
      }
    } catch (cause) {
      if (active.current === context && serial === request.current)
        setError(t('Could not load viewed marks: {0}', errorMessage(cause)));
    } finally {
      if (active.current === context && serial === request.current) setLoading(false);
    }
  }, [sessionId, snapshotIds, context]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    setStatuses(new Set());
    setPending(new Set());
    setError('');
    void reload();
  }, [reload]);
  const setViewed = async (snapshot: Snapshot, path: string, viewed: boolean) => {
    if (!sessionId) return;
    const id = key(snapshot, path);
    setPending((previous) => new Set(previous).add(id));
    try {
      await api(`/sessions/${sessionId}/viewed-files`, 'PUT', {
        snapshotId: snapshot.id,
        path: reviewFilePath(snapshot, path),
        viewed,
      });
      await reloadRef.current();
    } catch (cause) {
      if (active.current === context)
        setError(t('Could not save the viewed mark: {0}', errorMessage(cause)));
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };
  const isViewed = useCallback(
    (snapshot: Snapshot, path: string) => statuses.has(key(snapshot, path)),
    [statuses],
  );
  return {
    isViewed,
    setViewed,
    isPending: (snapshot: Snapshot, path: string) => pending.has(key(snapshot, path)),
    loading,
    error,
    reload,
  };
}
