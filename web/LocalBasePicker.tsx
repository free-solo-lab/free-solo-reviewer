import { useId, useState } from 'react';
import type { Repository } from '../shared/model';
import { errorMessage } from '../shared/errors';
import { useRepositoryBranches } from './queries';
import { t } from '../shared/i18n';

const OTHER = '\u0000other';

/**
 * What a local review compares the working folder with: a branch from the list, HEAD, or any
 * commit or ref typed by hand. The compact variant sits in an open review, where every change
 * reloads the code, so a typed ref applies only on Enter or when the field loses focus.
 */
export function LocalBasePicker({
  repo,
  value,
  disabled,
  compact,
  className,
  onChange,
}: {
  repo: Pick<Repository, 'id' | 'name'>;
  value: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const branches = useRepositoryBranches(repo.id);
  const [custom, setCustom] = useState(false),
    [draft, setDraft] = useState<string | null>(null);
  const { current = null, local = [], remote = [] } = branches.data ?? {};
  // A commit or a ref the list does not have stays editable as text.
  const typed =
    custom ||
    (!branches.isPending && value !== 'HEAD' && !local.includes(value) && !remote.includes(value));
  const submit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== value) onChange(next);
  };
  const id = useId();
  return (
    <>
      <div className={className ?? 'local-base-field'}>
        {!compact && <label htmlFor={id}>{t('Compare with a branch or commit')}</label>}
        <select
          id={id}
          aria-label={compact ? t('Comparison base for {0}', repo.name) : undefined}
          title={
            compact
              ? branches.isError
                ? t('Could not list the branches: {0}', errorMessage(branches.error))
                : t('Compare with a branch or commit')
              : undefined
          }
          value={typed ? OTHER : value}
          disabled={disabled || branches.isPending}
          onChange={(event) => {
            const next = event.target.value;
            setCustom(next === OTHER);
            if (next !== OTHER) onChange(next);
          }}
        >
          <option value="HEAD">{t('HEAD · uncommitted changes only')}</option>
          {branches.isPending && value !== 'HEAD' && <option value={value}>{value}</option>}
          {local.length > 0 && (
            <optgroup label={t('Local branches')}>
              {local.map((branch) => (
                // The checked-out branch is what is reviewed; compared with itself it is HEAD.
                <option value={branch} key={branch} disabled={branch === current}>
                  {branch}
                  {branch === current ? t(' · current, under review') : ''}
                </option>
              ))}
            </optgroup>
          )}
          {remote.length > 0 && (
            <optgroup label={t('Remote branches')}>
              {remote.map((branch) => (
                <option value={branch} key={branch}>
                  {branch}
                </option>
              ))}
            </optgroup>
          )}
          <option value={OTHER}>{t('Another commit or ref…')}</option>
        </select>
        {typed && (
          <input
            aria-label={t('Comparison base for {0}', repo.name)}
            placeholder={t('Commit, tag or branch')}
            value={compact ? (draft ?? value) : value}
            disabled={disabled}
            autoFocus={custom}
            onChange={(event) =>
              compact ? setDraft(event.target.value) : onChange(event.target.value)
            }
            onKeyDown={(event) => {
              if (!compact) return;
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') {
                setDraft(null);
                setCustom(false);
              }
            }}
            onBlur={compact ? submit : undefined}
          />
        )}
        {!compact && current && (
          <span
            className="local-base-head"
            title={t('The reviewed branch with uncommitted changes')}
          >
            ← {current}
          </span>
        )}
      </div>
      {branches.isError && !compact && (
        <p className="alert error" role="alert">
          {t('Could not list the branches: {0}', errorMessage(branches.error))}
        </p>
      )}
    </>
  );
}
