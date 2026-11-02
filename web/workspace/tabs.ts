import type { IconName } from '../icons';
import { t } from '../../shared/i18n';

export const tabs = [
  ['overview', t('Overview')],
  ['contracts', t('Contracts')],
  ['database', t('Database')],
  ['tests', t('Tests')],
  ['review', t('Code and review')],
  ['comments', t('Comments')],
] as const;
export type Tab = (typeof tabs)[number][0];
export const isTab = (value: string | undefined): value is Tab => tabs.some(([id]) => id === value);
export const tabIcons: Record<Tab, IconName> = {
  overview: 'overview',
  contracts: 'contracts',
  database: 'database',
  tests: 'tests',
  review: 'code',
  comments: 'message',
};
