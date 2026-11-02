import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactionContent } from '../shared/reactions';
import type { ReviewDiscussion } from '../shared/model';
import { api } from './api';
import { errorMessage } from '../shared/errors';
export function useReviewDiscussion(
  sessionId: string | undefined,
  refreshId: string | undefined,
  initial: ReviewDiscussion[],
  discussionRevision?: string,
) {
  const seeded = useRef({ sessionId, discussionRevision });
  const active = useRef(sessionId);
  active.current = sessionId;
  const [state, setState] = useState<{ id?: string; comments: ReviewDiscussion[] }>({
    comments: [],
  });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const serial = useRef(0);
  const reload = useCallback(async () => {
    if (!sessionId) return;
    const request = ++serial.current;
    setLoading(true);
    try {
      const result = await api<{ comments: ReviewDiscussion[]; warnings: string[] }>(
        `/sessions/${sessionId}/discussion`,
      );
      if (active.current === sessionId && serial.current === request) {
        setState({ id: sessionId, comments: result.comments });
        setError(result.warnings.join(' '));
      }
    } catch (error) {
      if (active.current === sessionId) setError(errorMessage(error));
    } finally {
      if (active.current === sessionId && serial.current === request) setLoading(false);
    }
  }, [sessionId]);
  useEffect(() => {
    const received =
      seeded.current.sessionId === sessionId &&
      !!discussionRevision &&
      seeded.current.discussionRevision !== discussionRevision;
    seeded.current = { sessionId, discussionRevision };
    setState({ id: sessionId, comments: initial });
    setError('');
    if (!received) void reload();
    return () => {
      serial.current++;
    };
  }, [sessionId, refreshId, reload, discussionRevision]);
  const reply = async (repoId: string, rootId: string, body: string) => {
    if (!sessionId) return;
    const result = await api<ReviewDiscussion>(
      `/sessions/${sessionId}/discussion/replies`,
      'POST',
      { repoId, rootId, body },
    );
    if (active.current === sessionId) {
      serial.current++;
      setLoading(false);
      setState((previous) => ({
        id: sessionId,
        comments: [
          ...previous.comments.filter(
            (comment) => comment.id !== result.id || comment.repoId !== result.repoId,
          ),
          result,
        ],
      }));
    }
  };
  const react = async (
    repoId: string,
    commentId: string,
    content: ReactionContent,
    enabled: boolean,
  ) => {
    if (!sessionId) return;
    const result = await api<ReviewDiscussion>(
      `/sessions/${sessionId}/discussion/reactions`,
      'PUT',
      { repoId, commentId, content, active: enabled },
    );
    if (active.current === sessionId) {
      serial.current++;
      setLoading(false);
      setState((previous) => ({
        id: sessionId,
        comments: previous.comments.map((comment) =>
          comment.id === result.id && comment.repoId === result.repoId ? result : comment,
        ),
      }));
    }
  };
  return {
    comments: state.id === sessionId ? state.comments : initial,
    loading,
    error,
    reload,
    reply,
    react,
  };
}
