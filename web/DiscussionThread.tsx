import React, { useState } from 'react';
import type { CodeDiscussion } from '../shared/discussion-threads';
import type { ReactionContent } from '../shared/reactions';
import { MessageReactions } from './MessageReactions';
import { authorColors } from './author-colors';
import { Markdown } from './Markdown';

export function DiscussionThread({
  thread,
  sessionId,
  onReply,
  onReact,
}: {
  onReact?: (
    repoId: string,
    commentId: string,
    content: ReactionContent,
    active: boolean,
  ) => Promise<void>;
  thread: CodeDiscussion;
  sessionId: string;
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
    <div className="code-comment-thread github-thread" role="region" aria-label="Обсуждение GitHub">
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
            <time dateTime={comment.at}>{new Date(comment.at).toLocaleString('ru')}</time>
            {index > 0 && <small>Ответ</small>}
          </div>
          <Markdown>{comment.body}</Markdown>
          <MessageReactions comment={comment} onReact={onReact} />
        </article>
      ))}
      {onReply && !thread.root.replyTo && (
        <div className="github-reply-editor">
          {!open ? (
            <button onClick={() => setOpen(true)}>Ответить в ветке</button>
          ) : (
            <>
              <div className="github-reply-heading">
                <strong>Ответ в GitHub</strong>
                <button
                  aria-label="Отменить ответ"
                  disabled={pending}
                  onClick={() => {
                    write('');
                    setOpen(false);
                    setError('');
                  }}
                >
                  ×
                </button>
              </div>
              <textarea
                aria-label="Ответ в ветке GitHub"
                value={body}
                disabled={pending}
                onChange={(event) => write(event.target.value)}
                placeholder="Продолжить обсуждение…"
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
                      `${cause instanceof Error ? cause.message : String(cause)} Текст сохранён. Перед повторной отправкой обновите ответы и проверьте ветку.`,
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? 'Отправляем…' : 'Отправить ответ в GitHub'}
              </button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
