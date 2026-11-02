import type { Evidence, Snapshot, SourceIndex } from '../../shared/model';
import { definitionReviewChange, type MethodLink } from '../../shared/code-navigation';
import styles from './SourcePanel.module.css';
import { t } from '../../shared/i18n';

export function DefinitionPicker({
  link,
  snapshots,
  indexes,
  onSelect,
  onClose,
}: {
  link: MethodLink;
  snapshots: Snapshot[];
  indexes: SourceIndex[];
  onSelect: (evidence: Evidence, line: number) => void;
  onClose: () => void;
}) {
  const ownerName = (method: MethodLink['targets'][number]) =>
    method.owner ?? method.evidence.path.split('/').pop() ?? '';
  const shortName = (name: string) => name.split('.').pop() ?? name;
  // The package is shown only when two targets would otherwise read the same.
  const shortNames = link.targets.map((method) => shortName(ownerName(method)));
  return (
    <div className={styles.picker} role="region" aria-label={t('Choose a method definition')}>
      <strong>
        {t('Open')} {link.name}
        {t(': the interface or an implementation')}
      </strong>
      {link.targets.map((method, i) => {
        const change = definitionReviewChange(method, snapshots);
        const label = change
          ? change.scope === 'method'
            ? t('Method changed in the PR')
            : t('Implementation file changed in the PR')
          : undefined;
        const type = indexes
          .filter(
            (index) =>
              index.repoId === method.evidence.repoId && index.side === method.evidence.side,
          )
          .flatMap((index) => index.types ?? [])
          .find((type) => type.qualifiedName === method.owner);
        return (
          <button
            key={i}
            className={change ? styles.changedDefinition : undefined}
            data-change-scope={change?.scope}
            title={[`${method.evidence.path}:${method.evidence.startLine}`, method.signature, label]
              .filter(Boolean)
              .join('\n')}
            onClick={() => onSelect(method.evidence, link.line)}
          >
            <span className={styles.definitionHeading}>
              <strong>
                {type?.kind === 'interface' ? t('Interface') : t('Class')} ·{' '}
                {shortNames.filter((name) => name === shortNames[i]).length > 1
                  ? ownerName(method)
                  : shortNames[i]}
              </strong>
              {change && (
                <span
                  className={`review-revision-dot ${change.kind}`}
                  title={label}
                  aria-label={label}
                />
              )}
            </span>
          </button>
        );
      })}
      <button onClick={onClose}>{t('Cancel navigation')}</button>
    </div>
  );
}
