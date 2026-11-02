import type { ReviewerDesktop } from '../shared/platform';
import { api } from './api';
export function platform(): 'browser' | 'desktop' {
  return window.reviewerDesktop?.platform ?? 'browser';
}
export async function chooseRepositoryDirectory(): Promise<string | null> {
  const native: ReviewerDesktop | undefined = window.reviewerDesktop;
  if (native) return native.chooseDirectory();
  return (await api<{ path: string | null }>('/repositories/pick-directory', 'POST', {})).path;
}
