import type { DraftComment } from '../shared/model';
import { withoutRecheckMarker, type FixCompletion, type FixStep } from '../shared/fix-chat';
import { Markdown } from './Markdown';
import styles from './FixChat.module.css';
import { getLanguage, t, tc } from '../shared/i18n';

const marks = { todo: '○', running: '◐', done: '✓', failed: '!' };
const labels = {
  todo: t('Not done'),
  running: t('In progress'),
  done: tc('step status', 'Done'),
  failed: t('Error'),
};

export function FixPlan({
  tasks,
  completed,
  stepOf,
  disabled,
  skipDisabled,
  onRun,
  onSkip,
  onCode,
}: {
  tasks: DraftComment[];
  completed: FixCompletion[];
  stepOf: (id: string) => FixStep | undefined;
  disabled: boolean;
  /** Skipping stays possible while Codex runs the other steps. */
  skipDisabled: boolean;
  onRun: (id: string) => void;
  /** Declines a step, or returns a declined one to the plan. */
  onSkip: (id: string, skipped: boolean) => void;
  onCode: (comment: DraftComment) => void;
}) {
  if (!tasks.length && !completed.length) return null;
  const skipped = completed.filter((step) => step.skipped).length;
  return (
    <section className={styles.fixPlan} aria-label={t('Fix plan')}>
      {tasks.length > 0 && (
        <>
          <header>
            <strong>{t('Fix plan')}</strong>
            <small>
              {t('left')} {tasks.length}
            </small>
          </header>
          <ol>
            {tasks.map((task) => {
              const state = stepOf(task.id)?.state ?? 'todo';
              return (
                <li key={task.id} className={styles[state]}>
                  <span className={styles.stepMark} aria-label={labels[state]}>
                    {marks[state]}
                  </span>
                  <span className={styles.stepText}>
                    {task.evidence && (
                      <button className={styles.stepRef} onClick={() => onCode(task)}>
                        {task.evidence.path.split('/').pop()}:{task.evidence.startLine}
                      </button>
                    )}
                    {task.body}
                  </span>
                  {state !== 'running' && (
                    <span className={styles.stepActions}>
                      <button
                        className="text-button"
                        disabled={skipDisabled}
                        title={t('Remove the step from the plan without changes')}
                        onClick={() => onSkip(task.id, true)}
                      >
                        {t('Skip')}
                      </button>
                      <button
                        className="text-button"
                        disabled={disabled}
                        onClick={() => onRun(task.id)}
                      >
                        {t('Run')}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {completed.length > 0 && (
        <details className={styles.stepHistory}>
          <summary>
            {skipped < completed.length
              ? `${t('History · done')} ${completed.length - skipped}`
              : t('History')}
            {skipped > 0 && ` · ${t('skipped')} ${skipped}`}
          </summary>
          <ol>
            {completed.map((step) => (
              <li
                key={`${step.repoId}:${step.commentId}`}
                className={step.skipped ? styles.skipped : undefined}
              >
                <span
                  className={styles.stepMark}
                  aria-label={step.skipped ? t('Skipped') : tc('step status', 'Done')}
                >
                  {step.skipped ? '–' : '✓'}
                </span>
                <div>
                  <div>{withoutRecheckMarker(step.body)}</div>
                  {step.at && (
                    <small>
                      {step.skipped && `${t('Skipped')} · `}
                      {new Date(step.at).toLocaleString(getLanguage())}
                    </small>
                  )}
                  {step.result && (
                    <details>
                      <summary>{t('Result')}</summary>
                      <Markdown>{step.result}</Markdown>
                    </details>
                  )}
                </div>
                {step.skipped && (
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() => onSkip(step.commentId, false)}
                  >
                    {t('Return to the plan')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
