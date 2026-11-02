import type { Finding } from '../../shared/model';
import { Icon } from '../icons';
import { cx } from '../ui/cx';
import { EvidenceLinks } from './EvidenceLinks';
import { Badge, severity } from './Badge';
import { useWorkspace } from './state';
import styles from './FindingCard.module.css';
import { t } from '../../shared/i18n';

export function FindingCard({ finding: f }: { finding: Finding }) {
  const { reviewVersion, addComment } = useWorkspace();
  return (
    <article className={cx(styles.card, styles[f.severity])}>
      <header className={styles.top}>
        <span className={cx(styles.risk, styles[f.severity])}>{severity[f.severity]}</span>
        <Badge value={f.confidence} />
      </header>
      <h3 className={styles.title}>{f.title}</h3>
      <p className={styles.summary}>{f.summary}</p>
      <footer className={styles.footer}>
        <EvidenceLinks refs={f.evidence} />
        <button
          className={cx('text-button', styles.add)}
          disabled={!!reviewVersion}
          onClick={() => addComment(`${f.title}\n\n${f.summary}`, f.evidence[0] ?? null)}
        >
          <Icon name="plus" size={13} />
          {t('To draft')}
        </button>
      </footer>
    </article>
  );
}
