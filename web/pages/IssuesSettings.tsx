import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryClient, queryKeys, useFeedback } from '../queries';
import {
  feedbackKinds,
  type FeedbackIssue,
  type FeedbackKind,
  type FeedbackThread,
} from '../../shared/feedback';
import { errorMessage } from '../../shared/errors';
import { Dialog, DialogClose, DialogTitle } from '../ui/Dialog';
import { Icon, IconButton } from '../icons';
import { Markdown } from '../Markdown';
import { cx } from '../ui/cx';
import styles from './SettingsPage.module.css';
import { getLanguage, plural, t, tc } from '../../shared/i18n';

const placeholders: Record<FeedbackKind, string> = {
  bug: 'What did you do, what did you expect and what happened instead?',
  feature: 'What would you like Reviewer to do, and for which kind of review?',
  improvement: 'What is inconvenient today and how could it work better?',
  question: 'What would you like to know?',
};
const when = (at: string) =>
  new Date(at).toLocaleString(getLanguage(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Feedback to the developers as GitHub issues of the project, with the replies to them. */
export function IssuesSettings() {
  const feedback = useFeedback();
  const [open, setOpen] = useState<number | null>(null);
  const list = feedback.data;
  return (
    <section className={styles.page} aria-label={t('Issues')}>
      <header className={styles.header}>
        <h1>{t('Issues')}</h1>
        <p>
          {t(
            'Report a bug or suggest an idea to the Reviewer developers. It is published as an issue in {0} from your GitHub account, and replies show up here.',
            list?.repository ?? 'free-solo-lab/free-solo-reviewer',
          )}
        </p>
      </header>
      <NewIssue login={list?.login} onCreated={setOpen} />
      <h2 className={styles.sectionTitle}>
        {t('Your issues')} {!!list?.issues.length && <span>{list.issues.length}</span>}
      </h2>
      {feedback.isPending ? (
        <p className={styles.muted} role="status">
          {t('Loading issues from GitHub…')}
        </p>
      ) : feedback.error ? (
        <p className="alert error" role="alert">
          {feedback.error.message}{' '}
          <button onClick={() => void feedback.refetch()}>{t('Retry')}</button>
        </p>
      ) : !list?.issues.length ? (
        <p className={styles.muted}>{t('No issues yet. The ones you create appear here.')}</p>
      ) : (
        <ul className={cx(styles.card, styles.issues)}>
          {list.issues.map((issue) => (
            <IssueRow key={issue.number} issue={issue} onOpen={() => setOpen(issue.number)} />
          ))}
        </ul>
      )}
      {open !== null && <IssueDrawer number={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function NewIssue({ login, onCreated }: { login?: string; onCreated: (number: number) => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug'),
    [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [diagnostics, setDiagnostics] = useState(true),
    [sending, setSending] = useState(false),
    [error, setError] = useState('');
  const ready = title.trim().length >= 3 && !!body.trim();
  async function send() {
    setSending(true);
    setError('');
    try {
      const issue = await api<FeedbackIssue>('/feedback', 'POST', {
        kind,
        title,
        body,
        diagnostics,
      });
      setTitle('');
      setBody('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.feedback });
      onCreated(issue.number);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className={cx(styles.card, styles.newIssue)}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void send();
      }}
    >
      <div className={styles.kinds} role="radiogroup" aria-label={t('Kind')}>
        {feedbackKinds.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={kind === item.id}
            disabled={sending}
            onClick={() => setKind(item.id)}
          >
            {t(item.title)}
          </button>
        ))}
      </div>
      <label>
        {t('Title')}
        <input
          value={title}
          maxLength={200}
          disabled={sending}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('In a few words')}
        />
      </label>
      <label>
        {t('Description')}
        <textarea
          value={body}
          rows={6}
          disabled={sending}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t(placeholders[kind])}
        />
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={diagnostics}
          disabled={sending}
          onChange={(event) => setDiagnostics(event.target.checked)}
        />
        <span>
          {t('Add technical details')}
          <small>
            {t(
              'Operating system, Node.js and interface language. No code and no repository names.',
            )}
          </small>
        </span>
      </label>
      <p className={styles.effect}>
        <Icon name="alert" size={13} />
        {t(
          'Issues are public. Do not paste code, tokens or names of private projects; a screenshot can be added on GitHub afterwards.',
        )}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.formActions}>
        {login && <span className={styles.muted}>{t('Sent as @{0}', login)}</span>}
        <button className="primary" type="submit" disabled={sending || !ready}>
          {sending ? t('Sending…') : t('Create issue on GitHub')}
        </button>
      </div>
    </form>
  );
}

function IssueRow({ issue, onOpen }: { issue: FeedbackIssue; onOpen: () => void }) {
  const kind = feedbackKinds.find((item) => item.id === issue.kind);
  return (
    <li>
      <button className={styles.issue} onClick={onOpen} aria-haspopup="dialog">
        <span
          className={cx(styles.issueState, issue.state === 'closed' && styles.closed)}
          title={issue.state === 'open' ? tc('issue', 'Open') : tc('issue', 'Closed')}
        >
          <Icon name={issue.state === 'open' ? 'circleDashed' : 'circleCheck'} size={16} />
        </span>
        <span className={styles.issueMain}>
          <strong>{issue.title}</strong>
          <small>
            {kind && <span className={styles.runs}>{t(kind.title)}</span>}#{issue.number} ·{' '}
            {t('updated {0}', when(issue.updatedAt))}
            {issue.comments > 0 && ` · ${plural(issue.comments, 'reply', 'replies')}`}
          </small>
        </span>
        {issue.unread > 0 && (
          <span className={styles.unread}>{plural(issue.unread, 'new reply', 'new replies')}</span>
        )}
      </button>
    </li>
  );
}

/** One issue with its conversation; opening it marks the replies as read. */
function IssueDrawer({ number, onClose }: { number: number; onClose: () => void }) {
  const thread = useQuery({
    queryKey: queryKeys.feedbackThread(number),
    queryFn: () => api<FeedbackThread>(`/feedback/${number}`),
  });
  const [reply, setReply] = useState(''),
    [sending, setSending] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (thread.data)
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback, exact: true });
  }, [thread.data]);
  const issue = thread.data?.issue;
  async function send() {
    setSending(true);
    setError('');
    try {
      queryClient.setQueryData(
        queryKeys.feedbackThread(number),
        await api<FeedbackThread>(`/feedback/${number}/comments`, 'POST', { body: reply }),
      );
      setReply('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <Dialog
      variant="drawer"
      className={styles.drawer}
      dismissible={!sending}
      closeOnOutsideClick={!reply.trim()}
      onClose={onClose}
    >
      <header className={styles.drawerHeader}>
        <div>
          <small>
            #{number}
            {issue && ` · ${issue.state === 'open' ? tc('issue', 'Open') : tc('issue', 'Closed')}`}
          </small>
          <DialogTitle>{issue?.title ?? t('Issue')}</DialogTitle>
        </div>
        <div className={styles.drawerActions}>
          {issue && (
            <a href={issue.url} target="_blank" rel="noreferrer">
              {t('Open on GitHub ↗')}
            </a>
          )}
          <DialogClose asChild>
            <IconButton icon="close" label={t('Close')} tooltip={false} disabled={sending} />
          </DialogClose>
        </div>
      </header>
      <div className={styles.drawerBody}>
        {thread.isPending && <p className={styles.muted}>{t('Loading the conversation…')}</p>}
        {thread.error && (
          <p className="alert error" role="alert">
            {thread.error.message}
          </p>
        )}
        {issue && thread.data && (
          <ol className={styles.conversation}>
            {[
              { id: 0, author: issue.author, at: issue.createdAt, body: issue.body, own: true },
              ...thread.data.comments,
            ].map((message) => (
              <li key={message.id} className={cx(styles.message, message.own && styles.own)}>
                <small>
                  <strong>@{message.author}</strong> · {when(message.at)}
                </small>
                <Markdown>{message.body || t('No description.')}</Markdown>
              </li>
            ))}
          </ol>
        )}
      </div>
      {issue && (
        <footer className={cx(styles.drawerFooter, styles.replyBox)}>
          <textarea
            aria-label={t('Reply')}
            value={reply}
            rows={3}
            disabled={sending}
            placeholder={t('Reply in the issue…')}
            onChange={(event) => setReply(event.target.value)}
          />
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={sending || !reply.trim()}
            onClick={() => void send()}
          >
            {sending ? t('Sending…') : t('Send reply')}
          </button>
        </footer>
      )}
    </Dialog>
  );
}
