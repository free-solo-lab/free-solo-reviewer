import type { ReviewSession } from './model.js';

/** Keep the original reviewed material stable; current updates are a separate layer. */
export function displayedRevision(session: ReviewSession | null, selected = '') {
  if (selected === 'current') return undefined;
  if (selected) return session?.history?.find((revision) => revision.id === selected);
  return session?.history?.[0];
}
export function hasRefreshChanges(before: ReviewSession, after: ReviewSession) {
  return (
    before.run?.id !== after.run?.id ||
    before.update?.id !== after.update?.id ||
    before.snapshots.map((snapshot) => snapshot.id).join(',') !==
      after.snapshots.map((snapshot) => snapshot.id).join(',')
  );
}
