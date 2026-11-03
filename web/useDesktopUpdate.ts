import { useEffect, useState } from 'react';
import type { UpdateState } from '../shared/platform';
import { errorMessage } from '../shared/errors';

/** The desktop app's update state; null in the browser and in apps built before updates. */
export function useDesktopUpdate() {
  const updates = typeof window === 'undefined' ? undefined : window.reviewerDesktop?.updates;
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!updates) return;
    void updates.state().then(setState);
    return updates.subscribe(setState);
  }, [updates]);
  if (!updates) return null;
  return {
    state,
    check: () => void updates.check().then(setState),
    install: () =>
      void updates
        .install()
        .catch((error) => setState({ state: 'error', message: errorMessage(error) })),
  };
}

/** Downloaded share of the update, in whole percent. */
export const downloadPercent = (state: Extract<UpdateState, { state: 'downloading' }>) =>
  state.total ? Math.floor((state.received / state.total) * 100) : 0;
