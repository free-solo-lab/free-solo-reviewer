import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ReviewDraft, ReviewRevision, ReviewSession } from '../../shared/model';
import { api } from '../api';
import { cacheDrafts, clearDraftCache, restoreDrafts, DraftSaveQueue } from '../draft-cache';
import { t } from '../../shared/i18n';

/** Review drafts of the open session, saved shortly after each change and backed up locally. */
export function useDrafts({
  sessionData,
  reviewVersion,
  liveSession,
  setError,
}: {
  sessionData: ReviewSession | null;
  reviewVersion: ReviewRevision | undefined;
  liveSession: MutableRefObject<string | null>;
  setError: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]),
    [dirty, setDirty] = useState(false);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftRevision = useRef(0);
  const draftSaveQueue = useRef(new DraftSaveQueue());
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
        setError(t('Could not save the draft: {0}', error.message)),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [drafts, dirty, sessionData?.id]);
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
          t(
            'Browser backup is unavailable. Wait until the draft is saved before reloading the page.',
          ),
        );
      }
    }
    setDrafts(next);
    setDirty(true);
  }
  /** Server drafts of a freshly opened session, with unsaved local edits recovered. */
  function resetDrafts(sessionId: string, server: ReviewDraft[]) {
    const restored = restoreDrafts(sessionId, server);
    draftRevision.current++;
    draftsRef.current = restored.drafts;
    setDrafts(restored.drafts);
    setDirty(restored.recovered);
  }
  function clearDrafts() {
    setDrafts([]);
    setDirty(false);
  }
  return { drafts, setDrafts, dirty, saveDrafts, updateDraft, resetDrafts, clearDrafts };
}
