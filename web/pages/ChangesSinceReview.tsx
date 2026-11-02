import { reviewPeriod } from '../../shared/review-period';
import type { ReactNode } from 'react';
import type { ModelResult } from '../../shared/model';
import { omitSections } from '../../shared/review-description';
import { Markdown } from '../Markdown';
import { Gaps } from '../components';
import { cx } from '../ui/cx';
import { plural } from '../ui/plural';
import { EvidenceLinks } from '../workspace/EvidenceLinks';
import { useWorkspace } from '../workspace/state';
import styles from './ChangesSinceReview.module.css';
import { getLanguage, inAllLanguages, t, tc } from '../../shared/i18n';

type FollowUpItem = NonNullable<ModelResult['followUp']>['items'][number];
const labels: Record<FollowUpItem['status'], string> = {
  unknown: t('Check'),
  changed: tc('follow-up status', 'Changed'),
  fixed: t('Fixed'),
  answered: t('Answered'),
  still_present: t('Unchanged'),
};
// Items that still need a look come first.
const order: FollowUpItem['status'][] = ['unknown', 'changed', 'fixed', 'answered'];

/** What changed since the previous review: its essence, prior remarks and new replies. */
export function ChangesSinceReview() {
  const { sessionData, liveRun, setTab, scenarioUpdates, rangeComparison, reviewRange } =
    useWorkspace();
  const update = sessionData?.update;
  if (!update) return null;
  const prior = sessionData.history?.find((revision) => revision.id === update.previousReviewId);
  const files = rangeComparison
    ? rangeComparison.snapshots.reduce((n, s) => n + s.files.length, 0)
    : update.changes.reduce((n, c) => n + c.files.length, 0);
  const period =
    sessionData && reviewRange
      ? reviewPeriod(sessionData, reviewRange.from.id, files > 0)
      : undefined;
  const followUp = period
    ? { items: period.items, summary: period.summaries.map((s) => s.text).join('\n\n') }
    : liveRun?.result.followUp;
  const scenarioCounts = { added: 0, modified: 0, removed: 0 };
  for (const change of scenarioUpdates.values()) scenarioCounts[change.kind]++;
  const scenarioSummary = [
    scenarioCounts.added && plural(scenarioCounts.added, 'new', 'new'),
    scenarioCounts.modified && plural(scenarioCounts.modified, 'changed', 'changed'),
    scenarioCounts.removed && plural(scenarioCounts.removed, 'removed', 'removed'),
  ].filter(Boolean);
  const items = (followUp?.items ?? [])
    .filter((item) => item.status !== 'still_present')
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const unchanged = (followUp?.items ?? []).filter((item) => item.status === 'still_present');
  const titleOf = (item: FollowUpItem) =>
    (
      period?.titles.get(item.previousId) ??
      prior?.run.result.findings.find((finding) => finding.id === item.previousId)?.title ??
      prior?.drafts.flatMap((draft) => draft.comments).find((c) => c.id === item.previousId)?.body
    )
      ?.split('\n')
      .find((line) => line.trim());
  const item = (entry: FollowUpItem, index: number): ReactNode => (
    <li key={`${entry.previousId}:${index}`} className={styles.item}>
      <span
        className={cx(styles.status, styles[entry.status])}
        title={t('The model’s assessment of the current code')}
      >
        {labels[entry.status]}
      </span>
      <div className={styles.itemBody}>
        {titleOf(entry) && <strong title={titleOf(entry)}>{titleOf(entry)}</strong>}
        <Markdown>{entry.summary}</Markdown>
        <EvidenceLinks refs={entry.evidence} versionId="current" />
      </div>
    </li>
  );
  return (
    <div className={styles.changes}>
      <p className={styles.meta}>
        {(period?.at || prior) &&
          t(
            'Review of {0} · ',
            new Date(period?.at ?? prior!.run.finishedAt ?? prior!.savedAt).toLocaleString(
              getLanguage(),
              {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              },
            ),
          )}
        <button className="text-button" onClick={() => setTab('review')}>
          {plural(files, 'file changed', 'files changed')} →
        </button>
      </p>
      {files > 0 && !liveRun ? (
        <p className={styles.pending}>
          {t(
            'The changes have not been analyzed yet. “Analyze updates” checks the fixes and replies; the previous review is kept.',
          )}
        </p>
      ) : files > 0 && liveRun?.state === 'running' && !followUp ? (
        <p className={styles.pending}>{t('Codex is analyzing the changes and replies…')}</p>
      ) : null}
      {followUp?.summary && (
        <Markdown>{omitSections(followUp.summary, inAllLanguages('Discussion replies'))}</Markdown>
      )}
      {scenarioSummary.length > 0 && (
        <p className={styles.meta}>
          {t('Scenarios:')} {scenarioSummary.join(', ')}{' '}
          {t('— marked with a dot in the menu on the left')}
        </p>
      )}
      {items.length > 0 && (
        <>
          <h3 className={styles.heading}>
            {t('Previous remarks')} <span>{items.length}</span>
          </h3>
          <ul className={styles.items}>{items.map(item)}</ul>
        </>
      )}
      {unchanged.length > 0 && (
        <details className={styles.more}>
          <summary>
            {t('Unchanged ·')} {unchanged.length}
          </summary>
          <ul className={styles.items}>{unchanged.map(item)}</ul>
        </details>
      )}
      {update.discussion.length > 0 && (
        <details className={styles.more}>
          <summary>
            {t('New replies on GitHub ·')} {update.discussion.length}
          </summary>
          {update.discussion.map((reply) => (
            <article key={`${reply.repoId}:${reply.id}`} className={styles.reply}>
              <a href={reply.url} target="_blank" rel="noreferrer">
                {reply.author}
              </a>
              <Markdown>{reply.body}</Markdown>
            </article>
          ))}
        </details>
      )}
      <Gaps gaps={update.gaps} />
    </div>
  );
}
