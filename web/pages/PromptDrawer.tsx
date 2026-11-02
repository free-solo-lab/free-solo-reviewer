import { useState } from 'react';
import { api } from '../api';
import { queryClient } from '../queries';
import { validatePrompt, type PromptSetting } from '../../shared/prompt-templates';
import { Dialog, DialogClose, DialogTitle } from '../ui/Dialog';
import { IconButton } from '../icons';
import styles from './SettingsPage.module.css';
import { t } from '../../shared/i18n';

export const promptsKey = ['settings', 'prompts'];

/**
 * One prompt template beside the analysis scheme. The edited text lives with the page, so closing
 * the panel keeps it until it is saved or discarded.
 */
export function PromptDrawer({
  prompt,
  stages,
  draft,
  onDraft,
  onClose,
}: {
  prompt: PromptSetting;
  /** The stages that send this prompt, by title. */
  stages: string[];
  draft: string | undefined;
  onDraft: (text: string | undefined) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const text = draft ?? prompt.template;
  const dirty = text !== prompt.template;
  async function save(reset = false) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (!reset) validatePrompt(prompt.id, text);
      const updated = await api<PromptSetting>(`/settings/prompts/${prompt.id}`, 'PUT', {
        template: reset ? null : text,
      });
      queryClient.setQueryData<PromptSetting[]>(promptsKey, (old) =>
        old?.map((p) => (p.id === updated.id ? updated : p)),
      );
      onDraft(undefined);
      setNotice(
        reset
          ? t('The default template is restored.')
          : t('Saved. The new template is used for the next requests.'),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog variant="drawer" className={styles.drawer} dismissible={!saving} onClose={onClose}>
      <header className={styles.drawerHeader}>
        <div>
          <small>{stages.join(' · ')}</small>
          <DialogTitle>{prompt.title}</DialogTitle>
        </div>
        <DialogClose asChild>
          <IconButton icon="close" label={t('Close')} tooltip={false} disabled={saving} />
        </DialogClose>
      </header>
      <div className={styles.drawerBody}>
        <p className={styles.muted}>{prompt.description}</p>
        {!!prompt.variables.length && (
          <details className={styles.variables}>
            <summary>
              {t('Required variables ·')} {prompt.variables.length}
            </summary>
            <p>
              {t(
                'The app fills these places with data of the current analysis. Keep the variables in the text; their values are not edited here.',
              )}
            </p>
            {prompt.variables.map((v) => (
              <code key={v}>{'{{' + v + '}}'}</code>
            ))}
          </details>
        )}
        <label htmlFor="prompt-template">{t('Request template')}</label>
        <textarea
          id="prompt-template"
          value={text}
          spellCheck={false}
          disabled={saving}
          onChange={(event) => {
            onDraft(event.target.value);
            setNotice('');
          }}
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className={styles.muted} role="status">
            {notice}
          </p>
        )}
      </div>
      <footer className={styles.drawerFooter}>
        <button disabled={saving || (!prompt.customized && !dirty)} onClick={() => void save(true)}>
          {t('Restore default')}
        </button>
        <button disabled={saving || !dirty} onClick={() => onDraft(undefined)}>
          {t('Discard changes')}
        </button>
        <button className="primary" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? t('Saving…') : t('Save')}
        </button>
      </footer>
    </Dialog>
  );
}
