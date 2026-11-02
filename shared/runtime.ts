import { t } from './i18n.js';
/** Shared browser/desktop service contract. Bump the protocol on incompatible API changes. */
export const SERVICE_NAME = 'free-solo-reviewer';
export const SERVICE_PROTOCOL = 1;
export const DEFAULT_PORT = 4318;
export interface ReviewerRuntime {
  service: typeof SERVICE_NAME;
  protocol: typeof SERVICE_PROTOCOL;
  pid: number;
  dataDir: string;
  instanceId: string;
}
export function isReviewerRuntime(value: unknown): value is ReviewerRuntime {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ReviewerRuntime>;
  return (
    r.service === SERVICE_NAME &&
    r.protocol === SERVICE_PROTOCOL &&
    Number.isInteger(r.pid) &&
    typeof r.dataDir === 'string' &&
    typeof r.instanceId === 'string'
  );
}
export function serviceUrl(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(t('Invalid Reviewer port.'));
  return `http://127.0.0.1:${port}`;
}
