import type { SessionListItem, SessionReviewState } from '../../shared/session-list';
import { getLanguage, t } from '../../shared/i18n';
import { Icon, IconButton, type IconName } from '../icons';
import { Tooltip } from '../ui/Tooltip';
import { cx } from '../ui/cx';
import styles from './Sidebar.module.css';

const states: Record<SessionReviewState, { icon: IconName; label: string; tone: string }> = {
  new: { icon: 'circleDashed', label: t('Not analyzed'), tone: 'neutral' },
  ready: { icon: 'circleCheck', label: t('Analysis ready'), tone: 'analyzed' },
  sent: { icon: 'send', label: t('Review sent'), tone: 'sent' },
  approved: { icon: 'check', label: t('You approved the current version'), tone: 'approved' },
  'review-again': {
    icon: 'refresh',
    label: t('The code changed after your approval'),
    tone: 'attention',
  },
  'local-sent': { icon: 'send', label: t('Sent to Codex'), tone: 'sent' },
  running: { icon: 'refresh', label: t('Analyzing'), tone: 'running' },
  partial: { icon: 'alert', label: t('Partial analysis'), tone: 'attention' },
  failed: { icon: 'alert', label: t('Analysis failed'), tone: 'failed' },
  cancelled: { icon: 'stop', label: t('Analysis stopped.'), tone: 'neutral' },
};

export function ReviewListItem({
  item,
  selected,
  needsAnswer,
  deleteDisabled,
  onOpen,
  onDelete,
}: {
  item: SessionListItem;
  selected: boolean;
  needsAnswer: boolean;
  deleteDisabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const status = needsAnswer
    ? { icon: 'alert' as const, label: t('Codex is waiting for your answer'), tone: 'attention' }
    : (states[item.reviewState] ?? states.new);
  const source = item.source === 'pr' ? t('Pull request on GitHub') : t('Local changes');
  const sourceLabel =
    item.source === 'pr'
      ? item.pullRequests?.map((pr) => `PR #${pr.number}`).join(', ') || 'PR'
      : t('Local');
  const date = new Date(item.updatedAt ?? item.createdAt);
  const tooltip = [
    item.title,
    source,
    item.branches?.join(', '),
    status.label,
    date.toLocaleString(getLanguage()),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={cx(styles.sessionRow, selected && styles.selected)}>
      <button
        className={styles.sessionOpen}
        onClick={onOpen}
        title={tooltip}
        aria-current={selected ? 'page' : undefined}
        aria-label={`${item.title} · ${sourceLabel} · ${status.label}`}
      >
        <span className={styles.sessionSource} title={source}>
          <Icon name={item.source === 'pr' ? 'pullRequest' : 'laptop'} size={16} />
        </span>
        <span className={styles.sessionDetails}>
          <span className={styles.sessionTitle}>{item.title}</span>
          <span className={styles.sessionMeta}>
            <span>{sourceLabel}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={item.updatedAt}>
              {date.toLocaleDateString(getLanguage(), { day: 'numeric', month: 'short' })}
            </time>
          </span>
        </span>
        <Tooltip label={status.label} side="right">
          <span
            className={cx(styles.sessionState, styles[status.tone])}
            role="img"
            aria-label={status.label}
          >
            <Icon name={status.icon} size={16} />
          </span>
        </Tooltip>
      </button>
      <IconButton
        icon="trash"
        label={t('Delete review “{0}”', item.title)}
        className={styles.sessionDelete}
        disabled={deleteDisabled}
        onClick={onDelete}
      />
    </div>
  );
}
