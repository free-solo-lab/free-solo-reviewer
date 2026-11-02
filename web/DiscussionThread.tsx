import React, { useEffect, useState } from 'react';
import type { CodeDiscussion } from '../shared/discussion-threads';
import type { ReactionContent } from '../shared/reactions';
import { MessageReactions } from './MessageReactions';
import { authorColors } from './author-colors';
import { Markdown } from './Markdown';
import { IconButton } from './icons';
import { errorMessage } from '../shared/errors';
import { getLanguage, t } from '../shared/i18n';

export function DiscussionThread({
  thread,
  sessionId,
  onReply,
  onReact,
  replyOpen,
}: {
  onReact?: (
    repoId: string,
    commentId: string,
    content: ReactionContent,
    active: boolean,
  ) => Promise<void>;
  thread: CodeDiscussion;
  sessionId: string;
  replyOpen?: number;
  onReply?: (repoId: string, rootId: string, body: string) => Promise<void>;
}) {
  const storageKey = `review-reply:${sessionId}:${thread.root.repoId}:${thread.root.id}`;
  const [body, setBody] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [open, setOpen] = useState(!!body),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (replyOpen) setOpen(true);
  }, [replyOpen]);
  const write = (value: string) => {
    setBody(value);
    try {
      if (value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch {
      /* Keep editing if storage is unavailable. */
    }
  };
  return (
    <div
      className="code-comment-thread github-thread"
      role="region"
      aria-label={t('GitHub discussion')}
    >
      {[thread.root, ...thread.replies].map((comment, index) => (
        <article
          className={`code-comment-card github-message ${index ? 'github-reply' : ''}`}
          key={comment.id}
          data-author={comment.author}
          style={authorColors(comment.author) as React.CSSProperties}
        >
          <div className="code-comment-heading">
            <a
              className="github-comment-author"
              href={comment.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="github-author-avatar" aria-hidden="true">
                {comment.author.slice(0, 2).toUpperCase()}
              </span>
              <strong>{comment.author}</strong> ↗
            </a>
            <time dateTime={comment.at}>{new Date(comment.at).toLocaleString(getLanguage())}</time>
            {index > 0 && <small>{t('Reply')}</small>}
          </div>
          <Markdown>{comment.body}</Markdown>
          <MessageReactions comment={comment} onReact={onReact} />
        </article>
      ))}
      {onReply && !thread.root.replyTo && (
        <div className="github-reply-editor">
          {!open ? (
            <button onClick={() => setOpen(true)}>{t('Reply in thread')}</button>
          ) : (
            <>
              <div className="github-reply-heading">
                <strong>{t('Reply on GitHub')}</strong>
                <IconButton
                  icon="close"
                  label={t('Cancel reply')}
                  tooltip={false}
                  disabled={pending}
                  onClick={() => {
                    write('');
                    setOpen(false);
                    setError('');
                  }}
                />
              </div>
              <textarea
                aria-label={t('Reply in the GitHub thread')}
                value={body}
                disabled={pending}
                onChange={(event) => write(event.target.value)}
                placeholder={t('Continue the discussion…')}
              />
              <button
                className="primary"
                disabled={pending || !body.trim()}
                onClick={async () => {
                  setPending(true);
                  setError('');
                  try {
                    await onReply(thread.root.repoId, thread.root.id, body.trim());
                    write('');
                    setOpen(false);
                  } catch (cause) {
                    setError(
                      t(
                        '{0} Your text is kept. Refresh the replies and check the thread before sending again.',
                        errorMessage(cause),
                      ),
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? t('Sending…') : t('Send reply to GitHub')}
              </button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
