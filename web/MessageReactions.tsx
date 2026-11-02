import { useEffect, useId, useRef, useState } from 'react';
import type { ReviewDiscussion } from '../shared/model';
import { REACTIONS, type ReactionContent } from '../shared/reactions';
import { t } from '../shared/i18n';
export function MessageReactions({
  comment,
  onReact,
}: {
  comment: ReviewDiscussion;
  onReact?: (
    repoId: string,
    commentId: string,
    content: ReactionContent,
    active: boolean,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const react = async (content: ReactionContent) => {
    if (!onReact || pending) return;
    const active = !comment.reactions?.find((reaction) => reaction.content === content)
      ?.viewerHasReacted;
    setPending(true);
    setError('');
    try {
      await onReact(comment.repoId, comment.id, content, active);
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('Could not save the reaction. Refresh the replies.'),
      );
    } finally {
      setPending(false);
    }
  };
  if (!onReact && !comment.reactions?.length) return null;
  return (
    <div className="message-reactions" ref={ref} aria-label={t('Message reactions')}>
      <div className="message-reaction-buttons">
        {onReact && (
          <button
            type="button"
            ref={toggle}
            className="reaction-add"
            aria-label={t('Add reaction')}
            title={t('Add reaction')}
            aria-expanded={open}
            aria-controls={pickerId}
            disabled={pending}
            onClick={() => setOpen(!open)}
          >
            ☺<span aria-hidden="true">+</span>
          </button>
        )}
        {REACTIONS.map(({ content, emoji, label }) => {
          const reaction = comment.reactions?.find((reaction) => reaction.content === content);
          return reaction && reaction.count > 0 ? (
            <button
              type="button"
              key={content}
              className={`reaction-count ${reaction.viewerHasReacted ? 'mine' : ''}`}
              aria-label={`${label}: ${reaction.count}${reaction.viewerHasReacted ? t(' · your reaction') : ''}`}
              title={`${label}${reaction.viewerHasReacted ? t(' · click to remove your reaction') : ''}`}
              aria-pressed={!!reaction.viewerHasReacted}
              disabled={!onReact || pending}
              onClick={() => void react(content)}
            >
              <span aria-hidden="true">{emoji}</span>
              <span>{reaction.count}</span>
            </button>
          ) : null;
        })}
      </div>
      {open && (
        <div
          className="reaction-picker"
          id={pickerId}
          role="group"
          aria-label={t('Choose a reaction')}
        >
          {REACTIONS.map(({ content, emoji, label }) => (
            <button
              type="button"
              key={content}
              aria-label={label}
              title={label}
              aria-pressed={
                !!comment.reactions?.find((reaction) => reaction.content === content)
                  ?.viewerHasReacted
              }
              disabled={pending}
              onClick={() => void react(content)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="reaction-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
