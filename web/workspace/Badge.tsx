import type { Confidence } from '../../shared/model';
import { t } from '../../shared/i18n';

export const states: Record<string, string> = {
  ready: t('Ready to analyze'),
  running: t('Analyzing'),
  complete: t('Analysis ready'),
  partial: t('Partial analysis'),
  failed: t('Interrupted'),
  cancelled: t('Cancelled'),
};
export const confidence: Record<Confidence, string> = {
  extracted: t('Extracted from code'),
  inferred: t('Model assumption'),
  unknown: t('Unknown'),
};
export const severity: Record<string, string> = {
  high: t('High risk'),
  medium: t('Needs attention'),
  low: t('Low risk'),
  info: t('Info'),
};
export function Badge({ value }: { value: Confidence }) {
  return <span className={`badge ${value}`}>{confidence[value]}</span>;
}
