import { useState } from 'react';
import type { ChangeCard } from '../../shared/model';
import { cx } from '../ui/cx';
import { useWorkspace } from '../workspace/state';
import styles from './ChangeCards.module.css';
import { t } from '../../shared/i18n';

const kinds: Record<ChangeCard['kind'], string> = {
  logic: t('Logic'),
  contract: t('Contract'),
  data: t('Data'),
  transaction: t('Transactions'),
  concurrency: t('Concurrency'),
  performance: t('Performance'),
  config: t('Configuration'),
  refactor: t('Refactoring'),
  cosmetic: t('Cosmetic'),
};
const order = Object.keys(kinds) as ChangeCard['kind'][];
const risks = { high: t('High risk'), check: t('Worth checking'), none: '' };
const rank = (card: ChangeCard) =>
  (card.risk === 'high' ? 0 : card.risk === 'check' ? 1 : 2) * 100 + order.indexOf(card.kind);
const SHOWN = 8;

/** One line per changed method or file: what it does now, its kind and whether to look closer. */
export function ChangeCards({
  cards,
  title = t('Changes'),
}: {
  cards: ChangeCard[];
  title?: string;
}) {
  const { openSource, matches } = useWorkspace();
  const [all, setAll] = useState(false);
  const visible = cards
    .filter((card) => matches([card.evidence]))
    .sort((a, b) => rank(a) - rank(b));
  if (!visible.length) return null;
  const shown = all ? visible : visible.slice(0, SHOWN);
  return (
    <section aria-label={title}>
      <h3 className={styles.title}>
        {title} <span>{visible.length}</span>
      </h3>
      <ul className={styles.list}>
        {shown.map((card) => (
          <li key={card.id}>
            <button className={styles.card} onClick={() => void openSource(card.evidence)}>
              <span
                className={cx(styles.risk, styles[card.risk])}
                title={risks[card.risk] || undefined}
                aria-label={risks[card.risk] || undefined}
              />
              <span className={styles.head}>
                <code className={styles.name}>{card.name}</code>
                <span className={styles.kind}>{kinds[card.kind]}</span>
              </span>
              <span className={styles.text}>{card.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {visible.length > SHOWN && (
        <button className="text-button" onClick={() => setAll(!all)}>
          {all ? t('Collapse') : t('Show all {0}', visible.length)}
        </button>
      )}
    </section>
  );
}
