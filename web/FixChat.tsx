import { useEffect, useRef, useState } from 'react';
import type { FixChat } from '../shared/fix-chat';
import type { Snapshot } from '../shared/model';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { queryKeys } from './queries';
import { Markdown } from './Markdown';
import { IconButton } from './icons';
import { Dialog, DialogClose, DialogTitle } from './ui/Dialog';
import { cx } from './ui/cx';
import { useWorkspace } from './workspace/state';
import styles from './FixChat.module.css';
import { FixPlan } from './FixPlan';
import { errorMessage } from '../shared/errors';
import { t } from '../shared/i18n';

const states: Record<FixChat['state'], string> = {
  planning: t('Codex is drafting a plan…'),
  planned: t('Plan ready'),
  applying: t('Codex is making fixes…'),
  stepped: t('Step done'),
  complete: t('Work finished'),
  failed: t('Work finished with an error'),
  cancelled: t('Work stopped'),
  waiting_input: t('Codex is waiting for your answer'),
  waiting_approval: t('Codex is waiting for approval'),
};
export function FixChatWindow({
  sessionId,
  snapshots,
  analysisRunning,
  onSave,
  onRefresh,
  onClose,
  embedded = false,
  history = [],
}: {
  embedded?: boolean;
  history?: import('../shared/fix-chat').FixChatEvent[];
  sessionId: string;
  snapshots: Snapshot[];
  analysisRunning: boolean;
  onSave: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  // Codex edits a working folder: local changes, or a PR checked out in the repository.
  const locals = snapshots.filter((snapshot) => snapshot.local || snapshot.pr);
  const { drafts, openSource } = useWorkspace();
  const [repoId, setRepoId] = useState(locals[0]?.repoId ?? '');
  const queryClient = useQueryClient();
  const [chat, setChat] = useState<FixChat | null>(null);
  useEffect(() => {
    if (chat)
      queryClient.setQueryData(queryKeys.fixCompletions(sessionId), chat.completedSteps ?? []);
  }, [chat, sessionId, queryClient]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // Repeats the failed request taking the changed working folder as the reviewer's own edits.
  const [acceptChanges, setAcceptChanges] = useState<(() => void) | null>(null);
  const fail = (error: unknown, accept: () => void) => {
    setError(errorMessage(error));
    if (error instanceof ApiError && error.code === 'working-folder-changed')
      setAcceptChanges(() => accept);
  };
  const running =
    chat?.state === 'planning' ||
    chat?.state === 'applying' ||
    (chat?.state === 'stepped' && !!chat.autoSteps);
  const snapshot = locals.find((item) => item.repoId === repoId);
  const completed = chat?.completedSteps?.filter((step) => step.repoId === repoId) ?? [];
  const tasks =
    drafts
      .find((draft) => draft.snapshotId === snapshot?.id && draft.state === 'draft')
      ?.comments.filter(
        (comment) => comment.forCodex && !completed.some((step) => step.commentId === comment.id),
      ) ?? [];
  const stepOf = (id: string) =>
    chat?.repoId === repoId ? chat.steps?.find((step) => step.commentId === id) : undefined;
  const done = completed.length;
  const pending = chat?.pending;
  const answerField = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    let active = true;
    void api<FixChat | null>(`/sessions/${sessionId}/fix-chat`)
      .then((value) => {
        if (!active) return;
        setChat(value);
        if (value && locals.some((item) => item.repoId === value.repoId)) setRepoId(value.repoId);
        setLoaded(true);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api<FixChat>(`/sessions/${sessionId}/fix-chat`)
        .then((value) => {
          if (active) setChat(value);
        })
        .catch((error) => {
          if (active) setError(error.message);
        });
    }, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat]);
  useEffect(() => {
    if (pending) answerField.current?.focus();
  }, [pending?.id]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const start = async (
    action: 'plan' | 'apply' | 'step',
    step: { stepId?: string; all?: boolean; acceptChanges?: boolean } = {},
  ) => {
    setBusy(true);
    setError('');
    setAcceptChanges(null);
    try {
      await onSave();
      const value = await api<FixChat>(`/sessions/${sessionId}/fix-chat`, 'POST', {
        repoId,
        action,
        message,
        ...step,
      });
      follow.current = true;
      setChat(value);
      void queryClient.invalidateQueries({ queryKey: queryKeys.fixAttention });
      setMessage('');
    } catch (error) {
      fail(error, () => void start(action, { ...step, acceptChanges: true }));
    } finally {
      setBusy(false);
    }
  };
  const respond = async (answer?: string, approved?: boolean, acceptChanges?: boolean) => {
    if (!pending) return;
    setBusy(true);
    setError('');
    setAcceptChanges(null);
    try {
      await onSave();
      const updated = await api<FixChat>(`/sessions/${sessionId}/fix-chat/respond`, 'POST', {
        requestId: pending.id,
        answer,
        approved,
        acceptChanges,
      });
      setChat(updated);
      setMessage('');
      follow.current = true;
      void queryClient.invalidateQueries({ queryKey: queryKeys.fixAttention });
    } catch (error) {
      fail(error, () => void respond(answer, approved, true));
    } finally {
      setBusy(false);
    }
  };
  const skip = async (commentId: string, skipped: boolean) => {
    setBusy(true);
    setError('');
    setAcceptChanges(null);
    try {
      await onSave();
      setChat(
        await api<FixChat>(`/sessions/${sessionId}/fix-chat/skip`, 'POST', {
          repoId,
          commentId,
          skipped,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.fixAttention });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setError('');
    setAcceptChanges(null);
    try {
      await api(`/sessions/${sessionId}/fix-chat/cancel`, 'POST', {});
      setChat(await api<FixChat>(`/sessions/${sessionId}/fix-chat`));
      void queryClient.invalidateQueries({ queryKey: queryKeys.fixAttention });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const events = [...history, ...(chat?.events ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const content = (
    <>
      {!embedded && (
        <header className={styles.fixChatHeading}>
          <div>
            <DialogTitle>{t('Fixes with Codex')}</DialogTitle>
            <small>{chat?.turnId ? states[chat.state] : t('Comments → plan → fixes')}</small>
          </div>
          <DialogClose asChild>
            <IconButton icon="close" label={t('Close the fixes chat')} tooltip={false} />
          </DialogClose>
        </header>
      )}
      <div className={styles.fixChatContext}>
        <select
          aria-label={t('Repository for fixes')}
          value={repoId}
          disabled={running || busy || !!pending}
          onChange={(event) => setRepoId(event.target.value)}
        >
          {locals.map((snapshot) => (
            <option key={snapshot.repoId} value={snapshot.repoId}>
              {snapshot.repoName}
            </option>
          ))}
        </select>
        <span>
          {tasks.length
            ? t('Each comment for Codex is a separate step. Fixes are made in the working folder.')
            : t('A plan for the selected comments. Fixes go into the working folder once started.')}
        </span>
      </div>
      <FixPlan
        tasks={loaded ? tasks : []}
        completed={completed}
        stepOf={stepOf}
        disabled={busy || running || analysisRunning || !!pending}
        onRun={(id) => void start('step', { stepId: id })}
        skipDisabled={busy}
        onSkip={(id, skipped) => void skip(id, skipped)}
        onCode={(task) => {
          if (task.evidence) void openSource(task.evidence);
        }}
      />
      <div
        className={styles.fixChatMessages}
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
      >
        {!chat?.events.length && (
          <p className="inline-empty">
            {tasks.length
              ? t(
                  'Run the steps one by one or all at once. Progress and check results appear here.',
                )
              : t(
                  'Leave comments while reading the code and press “Draft plan”. The plan, progress and check results appear here.',
                )}
          </p>
        )}
        {events.map((event) => (
          <article className={cx(styles.fixChatEvent, styles[event.kind])} key={event.id}>
            {event.kind === 'user' || event.kind === 'assistant' ? (
              <>
                <strong>{event.kind === 'user' ? t('You') : 'Codex'}</strong>
                <Markdown>{event.text}</Markdown>
              </>
            ) : event.kind === 'request' && event.request ? (
              <>
                <strong>
                  {event.request.kind === 'question'
                    ? t('Question from Codex')
                    : t('Approval needed')}
                </strong>
                <Markdown>{event.request.prompt}</Markdown>
                {event.request.resolution ? (
                  <small>
                    {
                      {
                        answered: t('Answer sent'),
                        approved: t('Approved'),
                        rejected: t('Declined'),
                        cancelled: t('Wait cancelled'),
                      }[event.request.resolution]
                    }
                    {event.request.response ? ` · ${event.request.response}` : ''}
                  </small>
                ) : event.request.id === pending?.id ? (
                  <>
                    <small>{t('Work is paused until you decide.')}</small>
                    {pending.kind === 'question' && pending.options.length > 0 && (
                      <div className={styles.fixQuestionOptions}>
                        {pending.options.map((option, index) => (
                          <button
                            key={index}
                            disabled={busy || analysisRunning}
                            onClick={() => void respond(option)}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </>
            ) : event.kind === 'plan' ? (
              <>
                <strong>{t('Plan')}</strong>
                <ul>
                  {event.tasks?.map((task, index) => (
                    <li key={index} className={task.completed ? styles.done : undefined}>
                      {task.completed ? '✓' : '○'} {task.text}
                    </li>
                  ))}
                </ul>
              </>
            ) : event.kind === 'command' || event.kind === 'files' || event.kind === 'rollback' ? (
              <details>
                <summary>
                  {
                    {
                      command: t('Execution and checks'),
                      files: t('File changes'),
                      rollback: t('Summary of changes and rollback point'),
                    }[event.kind]
                  }
                </summary>
                <pre>{event.text}</pre>
              </details>
            ) : (
              <p>{event.text}</p>
            )}
          </article>
        ))}
      </div>
      {chat?.postFix?.state === 'failed' && (
        <p className="alert error" role="alert">
          {chat.postFix.error}
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
          {acceptChanges && (
            <>
              {' '}
              <button className="text-button" disabled={busy} onClick={acceptChanges}>
                {t('Continue with the current files')}
              </button>
            </>
          )}
        </p>
      )}
      <footer className={styles.fixChatCompose}>
        {pending && (
          <div className={styles.fixWaitingLabel} role="status">
            {pending.kind === 'question'
              ? t('Your answer is needed')
              : t('Your approval is needed')}
          </div>
        )}
        <textarea
          ref={answerField}
          aria-label={pending ? t('Codex reply') : t('Codex message')}
          placeholder={
            pending
              ? pending.kind === 'question'
                ? t('Your answer to the question…')
                : t('Comment on the decision (optional)…')
              : t('Clarify the plan or add a task for the comments…')
          }
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={busy || running}
        />
        <div className={styles.fixChatActions}>
          {pending ? (
            <>
              {pending.kind === 'approval' ? (
                <>
                  <button
                    disabled={busy || analysisRunning}
                    onClick={() => void respond(message, false)}
                  >
                    {t('Decline')}
                  </button>
                  <button
                    className="primary"
                    disabled={busy || analysisRunning}
                    onClick={() => void respond(message, true)}
                  >
                    {t('Approve and continue')}
                  </button>
                </>
              ) : (
                <>
                  <button disabled={busy} onClick={() => void cancel()}>
                    {t('Cancel waiting')}
                  </button>
                  <button
                    className="primary"
                    disabled={busy || analysisRunning || !message.trim()}
                    onClick={() => void respond(message)}
                  >
                    {t('Answer and continue')}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                disabled={!loaded || busy || running || analysisRunning}
                onClick={() => void start('plan')}
              >
                {tasks.length ? t('Discuss the plan') : t('Draft plan')}
              </button>
              {tasks.length > 0 && !running && (
                <>
                  <button
                    disabled={!loaded || busy || analysisRunning || !!message.trim()}
                    onClick={() => void start('step', { all: true })}
                  >
                    {t('All steps')}
                  </button>
                  <button
                    className="primary"
                    disabled={!loaded || busy || analysisRunning}
                    onClick={() => void start('step')}
                  >
                    {done ? t('Next step') : t('Start with the first step')}
                  </button>
                </>
              )}
              {running ? (
                <button disabled={busy} onClick={() => void cancel()}>
                  {t('Stop')}
                </button>
              ) : chat?.state === 'planned' && chat.repoId === repoId && !tasks.length ? (
                <button
                  className="primary"
                  disabled={busy || analysisRunning || !!message.trim()}
                  onClick={() => void start('apply')}
                >
                  {t('Start fixing')}
                </button>
              ) : chat && ['complete', 'failed', 'cancelled'].includes(chat.state) ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void (
                      chat?.postFix?.state === 'failed'
                        ? api(`/sessions/${sessionId}/fix-chat/retry-update`, 'POST', {})
                        : onRefresh()
                    )
                      .then(() => onClose())
                      .catch((error) => setError(error.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t('Refresh code in the review')}
                </button>
              ) : null}
            </>
          )}
        </div>
        {analysisRunning && <small>{t('Wait for the current analysis to finish.')}</small>}
      </footer>
    </>
  );
  return embedded ? (
    <div className={styles.embedded}>{content}</div>
  ) : (
    <Dialog className={styles.fixChatWindow} closeOnOutsideClick={false} onClose={onClose}>
      {content}
    </Dialog>
  );
}
