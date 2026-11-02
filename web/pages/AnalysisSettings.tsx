import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryClient, queryKeys, useStepSettings, type StepSettings } from '../queries';
import type { PromptId, PromptSetting } from '../../shared/prompt-templates';
import {
  optionalSteps,
  stepMode,
  type OnDemandStep,
  type OptionalStep,
  type StepMode,
} from '../../shared/analysis-steps';
import {
  analysisPipeline,
  CONTINUATION_PROMPT,
  type PipelineStage,
} from '../../shared/analysis-pipeline';
import { errorMessage } from '../../shared/errors';
import { Icon } from '../icons';
import { cx } from '../ui/cx';
import { PromptDrawer, promptsKey } from './PromptDrawer';
import styles from './SettingsPage.module.css';
import { t } from '../../shared/i18n';

/** The analysis as a scheme of its stages: what each one sends to Codex, and whether it runs. */
export function AnalysisSettings() {
  const steps = useStepSettings();
  const settings: StepSettings = steps.data ?? { disabled: [], onDemand: [] };
  const [stepError, setStepError] = useState('');
  const prompts = useQuery({
    queryKey: promptsKey,
    queryFn: () => api<PromptSetting[]>('/settings/prompts'),
  });
  const [open, setOpen] = useState<PromptId | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<PromptId, string>>>({});
  const unsaved = (id: PromptId) => {
    const prompt = prompts.data?.find((p) => p.id === id);
    return !!prompt && drafts[id] !== undefined && drafts[id] !== prompt.template;
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(drafts).some((id) => unsaved(id as PromptId))) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [drafts, prompts.data]);

  async function setStepMode(step: OptionalStep, mode: StepMode) {
    setStepError('');
    const next: StepSettings = {
      disabled: [
        ...settings.disabled.filter((id) => id !== step),
        ...(mode === 'all' ? [step] : []),
      ],
      onDemand: [
        ...settings.onDemand.filter((id) => id !== step),
        ...(mode === 'method' ? [step as OnDemandStep] : []),
      ],
    };
    queryClient.setQueryData(queryKeys.steps, next);
    try {
      queryClient.setQueryData(
        queryKeys.steps,
        await api<StepSettings>('/settings/steps', 'PUT', next),
      );
    } catch (cause) {
      queryClient.setQueryData(queryKeys.steps, settings);
      setStepError(errorMessage(cause));
    }
  }

  const prompt = (id: PromptId) => prompts.data?.find((p) => p.id === id);
  const stagesOf = (id: PromptId) =>
    id === CONTINUATION_PROMPT
      ? [t('On continuation')]
      : analysisPipeline
          .filter((stage) => stage.prompts.some((p) => p.id === id))
          .map((stage) => t(stage.title));
  const chip = (id: PromptId) => {
    const value = prompt(id);
    return (
      <button
        type="button"
        className={styles.prompt}
        disabled={!value}
        aria-haspopup="dialog"
        onClick={() => setOpen(id)}
      >
        <Icon name="code" size={13} />
        {value?.title ?? id}
        {unsaved(id) ? (
          <span className={styles.flag}>{t('Not saved')}</span>
        ) : value?.customized ? (
          <span className={styles.flag}>{t('Customized')}</span>
        ) : null}
      </button>
    );
  };
  const opened = open && prompt(open);
  return (
    <section className={styles.page} aria-label={t('Analysis')}>
      <header className={styles.header}>
        <h1>{t('How the analysis works')}</h1>
        <p>
          {t(
            'Reviewer pins the code of the pull request, indexes it on this computer and then sends Codex one request per stage, in this order. Every stage starts a new Codex thread in a read-only copy of the code without network access; finished stages are saved, so an interrupted analysis continues where it stopped.',
          )}
        </p>
        <p>
          {t(
            'Turn off a stage to save time and tokens: it can still be run for one review from its page. Click a prompt to read or edit it; a change applies to the next requests and does not start an analysis.',
          )}
        </p>
      </header>
      {prompts.error && (
        <p className="alert error" role="alert">
          {prompts.error.message}{' '}
          <button onClick={() => void prompts.refetch()}>{t('Retry')}</button>
        </p>
      )}
      {stepError && (
        <p className="alert error" role="alert">
          {stepError}
        </p>
      )}
      <ol className={styles.pipeline}>
        {analysisPipeline.map((stage, index) => {
          const mode = stage.step ? stepMode(stage.step, settings) : 'auto';
          return (
            <li key={stage.id} className={cx(styles.stage, mode !== 'auto' && styles.stageOff)}>
              <span className={styles.stageNumber} aria-hidden="true">
                {index + 1}
              </span>
              <div className={styles.stageCard}>
                <div className={styles.stageHeading}>
                  <div>
                    <h2>{t(stage.title)}</h2>
                    <span className={cx(styles.runs, stage.runs === 'local' && styles.local)}>
                      <Icon name={stage.runs === 'local' ? 'laptop' : 'sparkles'} size={12} />
                      {stage.runs === 'local' ? t('On this computer') : 'Codex'}
                    </span>
                  </div>
                  <StageControl
                    stage={stage}
                    mode={mode}
                    disabled={steps.isPending}
                    onChange={(next) => stage.step && void setStepMode(stage.step, next)}
                  />
                </div>
                <p className={styles.muted}>{t(stage.summary)}</p>
                {mode !== 'auto' && stage.step && <StageEffect step={stage.step} mode={mode} />}
                {!!stage.prompts.length && (
                  <div className={styles.request}>
                    <span className={styles.requestLabel}>{t('Request')}</span>
                    {stage.prompts.map((part, i) => (
                      <Fragment key={part.id}>
                        {i > 0 && (
                          <span className={styles.plus} aria-hidden={!part.instead}>
                            {part.instead ? t('or') : '+'}
                          </span>
                        )}
                        <span className={styles.part}>
                          {chip(part.id)}
                          {part.when && <small>{t(part.when)}</small>}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className={cx(styles.muted, styles.continuation)}>
        {t('When an interrupted stage resumes, its request starts with')}{' '}
        {chip(CONTINUATION_PROMPT)}
      </p>
      {opened && (
        <PromptDrawer
          prompt={opened}
          stages={stagesOf(opened.id)}
          draft={drafts[opened.id]}
          onDraft={(text) =>
            setDrafts((old) => {
              const next = { ...old };
              if (text === undefined) delete next[opened.id];
              else next[opened.id] = text;
              return next;
            })
          }
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function StageControl({
  stage,
  mode,
  disabled,
  onChange,
}: {
  stage: PipelineStage;
  mode: StepMode;
  disabled: boolean;
  onChange: (mode: StepMode) => void;
}) {
  const step = optionalSteps.find((item) => item.id === stage.step);
  if (!step) return <span className={styles.always}>{t('Always runs')}</span>;
  if ('onDemand' in step)
    return (
      <select
        className={styles.mode}
        aria-label={t(stage.title)}
        value={mode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as StepMode)}
      >
        <option value="auto">{t('With every review')}</option>
        <option value="method">{t('On request, for the open method')}</option>
        <option value="all">{t('On request, for all at once')}</option>
      </select>
    );
  return (
    <label className={styles.switch}>
      <input
        type="checkbox"
        role="switch"
        aria-label={t(stage.title)}
        checked={mode === 'auto'}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked ? 'auto' : 'all')}
      />
      <span>{mode === 'auto' ? t('On') : t('Off')}</span>
    </label>
  );
}

function StageEffect({ step, mode }: { step: OptionalStep; mode: StepMode }) {
  const definition = optionalSteps.find((item) => item.id === step)!;
  return (
    <p className={styles.effect}>
      <Icon name="circleSlash" size={13} />
      {t(mode === 'method' && 'onDemand' in definition ? definition.onDemand : definition.effect)}
    </p>
  );
}
