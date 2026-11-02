import { useId, useState } from 'react';
import type { DraftComment } from '../../shared/model';
import type { FixCompletion } from '../../shared/fix-chat';
import { withoutRecheckMarker } from '../../shared/fix-chat';
import {
  acceptedFix,
  commentSteps,
  commentTitle,
  type CommentStep,
} from '../../shared/review-comment';
import { Icon, IconButton, type IconName } from '../icons';
import { Tooltip } from '../ui/Tooltip';
import { Markdown } from '../Markdown';
import { cx } from '../ui/cx';
import { getLanguage, t } from '../../shared/i18n';
import styles from './ReviewDialog.module.css';

const actions: Record<CommentStep['action'], string> = {
  comment: t('Added a comment'),
  handoff: t('Handed over to Codex'),
  review: t('Returned to the review'),
  queued: t('Waiting for Codex'),
  done: t('Fix completed'),
  skipped: t('Skipped'),
  accepted: t('Fix checked'),
  sent: t('Review sent'),
  restored: t('Return to the plan'),
};
const shortActions: Partial<Record<CommentStep['action'], string>> = {
  queued: t('queued'),
  done: t('done'),
  skipped: t('skipped'),
  accepted: t('checked'),
  sent: t('sent'),
  review: t('in the review'),
};
/** A short moment for a row: the year only when it is not the current one. */
function when(at: string) {
  const date = new Date(at);
  return date.toLocaleString(getLanguage(), {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}
function Step({
  step,
  author,
  compact,
}: {
  step: CommentStep;
  author?: string;
  compact?: boolean;
}) {
  const actor =
    step.actor === 'codex'
      ? 'Codex'
      : step.actor === 'github'
        ? 'GitHub'
        : step.action === 'comment'
          ? (author ?? t('You'))
          : t('You');
  const icon: IconName = step.pending
    ? 'circleDashed'
    : step.actor === 'codex'
      ? 'sparkles'
      : step.actor === 'github'
        ? 'send'
        : 'user';
  const actionLabel =
    step.pending && step.action === 'review' ? t('Waiting for your review') : actions[step.action];
  const label = `${actor} · ${actionLabel}${step.at ? ` · ${new Date(step.at).toLocaleString(getLanguage())}` : ''}`;
  return (
    <Tooltip label={label}>
      <span
        aria-label={label}
        className={cx(
          styles.step,
          step.actor === 'codex' && styles.codex,
          step.pending && styles.pending,
        )}
      >
        <Icon name={icon} size={13} />
        <span>
          {actor}
          {compact
            ? shortActions[step.action] && ` · ${shortActions[step.action]}`
            : ` · ${actionLabel}`}
        </span>
        {!compact && step.at && (
          <time dateTime={step.at}>{new Date(step.at).toLocaleString(getLanguage())}</time>
        )}
      </span>
    </Tooltip>
  );
}

export function ReviewCommentRow({
  comment,
  completion,
  author,
  sentAt,
  disabled,
  onChange,
  onDelete,
  onCode,
  onAccept,
  onSkip,
  onRestore,
  onFollowUp,
  onRun,
  onSelect,
  selected,
}: {
  comment: DraftComment;
  completion?: FixCompletion;
  author?: string;
  sentAt?: string;
  disabled?: boolean;
  onChange?: (patch: Partial<DraftComment>) => void;
  onDelete?: () => void;
  onCode?: () => void;
  onAccept?: () => void;
  onSkip?: () => void;
  onRestore?: () => void;
  onFollowUp?: () => void;
  onRun?: () => void;
  onSelect?: () => void;
  selected?: boolean;
}) {
  const [expanded, setExpanded] = useState(false),
    [menu, setMenu] = useState(false);
  const id = useId();
  const accepted = acceptedFix(comment, completion);
  const activeReview = !!onChange && !comment.forCodex && !sentAt;
  const status = activeReview
    ? t('In the review')
    : sentAt
      ? t('Review sent')
      : completion?.skipped
        ? t('Skipped')
        : accepted
          ? t('Fix checked')
          : completion
            ? t('Fix completed by Codex')
            : comment.forCodex
              ? t('Waiting for Codex')
              : t('In the review');
  const icon: IconName = activeReview
    ? 'message'
    : sentAt
      ? 'send'
      : completion?.skipped
        ? 'circleSlash'
        : completion
          ? 'circleCheck'
          : comment.forCodex
            ? 'circleDashed'
            : 'message';
  const steps = commentSteps(comment, completion, sentAt);
  if (activeReview && completion && steps.at(-1)?.action !== 'review')
    steps.push({ actor: 'reviewer', action: 'review', pending: true });
  const phases = steps.filter((step) => step.action !== 'handoff');
  const compact = phases.length > 3 ? [phases[0], ...phases.slice(-2)] : phases;
  // ISO timestamps sort as text; the latest one says when the comment last moved.
  const lastAt = steps
    .filter((step) => step.at && !step.pending && Number.isFinite(Date.parse(step.at)))
    .map((step) => step.at!)
    .sort()
    .at(-1);
  const editable = !!onChange;
  return (
    <article className={styles.comment} data-comment-id={comment.id}>
      <div className={styles.commentRow}>
        {onSelect ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onSelect}
            aria-label={t('Select comment')}
            disabled={disabled}
          />
        ) : (
          <Tooltip label={status}>
            <span
              role="img"
              aria-label={status}
              className={cx(
                styles.mark,
                completion?.skipped
                  ? styles.muted
                  : accepted
                    ? styles.accepted
                    : comment.forCodex && !completion
                      ? styles.codex
                      : styles.ready,
              )}
            >
              <Icon name={icon} size={16} />
            </span>
          </Tooltip>
        )}
        <div className={styles.commentMain}>
          <button
            className={styles.commentTitle}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
            title={withoutRecheckMarker(comment.body)}
          >
            {commentTitle(comment.body) || t('Comment')}
          </button>
          <div className={styles.chain} aria-label={t('Sequence of actions')}>
            {compact.map((step, index) => (
              <span className={styles.chainPart} key={`${step.action}:${index}`}>
                {index > 0 && <Icon name="arrowRight" size={11} />}
                <Step step={step} compact author={author} />
              </span>
            ))}
            {lastAt && (
              <time
                className={styles.when}
                dateTime={lastAt}
                title={new Date(lastAt).toLocaleString(getLanguage())}
              >
                {when(lastAt)}
              </time>
            )}
          </div>
        </div>
        <div className={styles.actions}>
          {onRun && (
            <IconButton icon="play" label={t('Run in Codex')} onClick={onRun} disabled={disabled} />
          )}
          {onCode && (
            <IconButton icon="code" label={t('Code related to this comment')} onClick={onCode} />
          )}
          {editable && (
            <IconButton
              icon="more"
              label={t('Comment actions')}
              aria-expanded={menu}
              aria-controls={`${id}-menu`}
              onClick={() => setMenu(!menu)}
            />
          )}
        </div>
      </div>
      {menu && editable && (
        <div className={styles.commentMenu} id={`${id}-menu`}>
          <button
            disabled={disabled}
            onClick={() => {
              if (completion && !comment.forCodex && onFollowUp) onFollowUp();
              else onChange({ forCodex: !comment.forCodex, selected: !!comment.forCodex });
              setMenu(false);
            }}
          >
            <Icon name={comment.forCodex ? 'message' : 'sparkles'} />
            {comment.forCodex ? t('In the review') : t('Hand over to Codex')}
          </button>
          {!comment.forCodex && (
            <button disabled={disabled} onClick={() => onChange({ selected: !comment.selected })}>
              <Icon name={comment.selected ? 'circleCheck' : 'circleDashed'} />
              {comment.selected ? t('Exclude from sending') : t('Include in the review')}
            </button>
          )}
          {onSkip && (
            <button disabled={disabled} onClick={onSkip}>
              <Icon name="circleSlash" />
              {t('Skip')}
            </button>
          )}
          {onRestore && (
            <button disabled={disabled} onClick={onRestore}>
              <Icon name="refresh" />
              {t('Return to the plan')}
            </button>
          )}
          {onDelete && (
            <button disabled={disabled} onClick={onDelete}>
              <Icon name="trash" />
              {t('Delete comment')}
            </button>
          )}
        </div>
      )}
      {expanded && (
        <div id={id} className={styles.commentDetails}>
          {editable ? (
            <textarea
              aria-label={t('Comment text')}
              className={styles.body}
              value={withoutRecheckMarker(comment.body)}
              onChange={(event) => onChange({ body: event.target.value })}
              disabled={disabled}
            />
          ) : (
            <p className={styles.original}>{withoutRecheckMarker(comment.body)}</p>
          )}
          {!comment.forCodex && editable && (
            <label className={styles.include}>
              <input
                type="checkbox"
                checked={comment.selected}
                disabled={disabled}
                onChange={(event) => onChange({ selected: event.target.checked })}
              />
              {t('Include in the review')}
            </label>
          )}
          <div className={styles.events}>
            {steps.map((step, index) => (
              <Step key={index} step={step} author={author} />
            ))}
          </div>
          {completion?.result && (
            <details className={styles.result}>
              <summary>{t('Result')}</summary>
              <Markdown>{completion.result}</Markdown>
            </details>
          )}
          {completion && !completion.skipped && (
            <div className={styles.detailActions}>
              {!accepted && onAccept && (
                <button disabled={disabled} onClick={onAccept}>
                  <Icon name="check" />
                  {t('Accept fix')}
                </button>
              )}
              {onFollowUp && (
                <button disabled={disabled} onClick={onFollowUp}>
                  <Icon name="sparkles" />
                  {t('Follow up with Codex')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
