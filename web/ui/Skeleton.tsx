import { cx } from './cx';
import styles from './Skeleton.module.css';

/** Placeholder rows where a list is about to appear; screen readers hear the label instead. */
export function SkeletonRows({
  count,
  label,
  className,
  rowClassName,
  uniform = false,
}: {
  count: number;
  label: string;
  className?: string;
  /** Full-width rows, like cards, instead of text lines of varying length. */
  uniform?: boolean;
  /** Sizes the rows like the items they stand for. */
  rowClassName?: string;
}) {
  return (
    <div
      className={cx(styles.rows, uniform && styles.uniform, className)}
      role="status"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={cx(styles.row, rowClassName)} aria-hidden="true" />
      ))}
    </div>
  );
}
