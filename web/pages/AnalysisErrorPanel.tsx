import { Icon } from '../icons';
import { useWorkspace } from '../workspace/state';
import styles from './AnalysisErrorPanel.module.css';
import { prefixPattern, startsLike, t, tc } from '../../shared/i18n';

const stages: Record<string, string> = {
  prepare: t('preparation'),
  review: t('main review'),
  scenarios: t('scenarios'),
  sql: t('database'),
  tests: tc('stage', 'tests'),
};

/** One line about an interrupted analysis; finished parts are kept and it can be continued. */
export function AnalysisErrorPanel() {
  const { session, liveRun } = useWorkspace();
  if (!session || !liveRun || !['partial', 'failed', 'cancelled'].includes(liveRun.state))
    return null;
  const reason =
    liveRun.error ?? liveRun.result.gaps.find((gap) => startsLike(gap, 'Codex/analysis: {0}'));
  if (!reason) return null;
  const stage = stages[liveRun.checkpoint?.stage ?? ''];
  return (
    <details className={styles.banner} role="alert">
      <summary>
        <Icon name="alert" size={14} />
        <strong>
          {t('Analysis interrupted')}
          {stage ? ` · ${stage}` : ''}
        </strong>
        <span className={styles.reason}>
          {reason.replace(new RegExp(`^${prefixPattern('Codex/analysis: {0}')}\\s*`), '')}
        </span>
        <span className={styles.more}>{t('Details')}</span>
      </summary>
      <p>
        {t(
          'Finished parts are saved. “Continue” in the header resumes from this stage without repeating finished work.',
        )}
      </p>
      <pre>{reason}</pre>
    </details>
  );
}
