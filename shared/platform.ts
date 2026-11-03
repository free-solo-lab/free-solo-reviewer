/** A release newer than the running app, as its signed manifest describes it. */
export interface AvailableUpdate {
  version: string;
  notes: string;
  notesUrl: string;
  /** A minor or major release may change data, so the data is copied before it is installed. */
  kind: 'patch' | 'minor' | 'major';
}
export type UpdateState =
  | { state: 'idle'; checkedAt?: string }
  | { state: 'checking' }
  | ({ state: 'downloading'; received: number; total: number } & AvailableUpdate)
  | ({ state: 'ready' } & AvailableUpdate)
  /** The app cannot replace itself here, e.g. it runs from the disk image or Downloads. */
  | ({ state: 'manual'; downloadUrl: string } & AvailableUpdate)
  | ({ state: 'installing' } & AvailableUpdate)
  | { state: 'error'; message: string; update?: AvailableUpdate };

/** Small native adapter; the review UI and API remain identical in both launch modes. */
export interface ReviewerDesktop {
  readonly platform: 'desktop';
  chooseDirectory(): Promise<string | null>;
  readonly updates: {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    install(): Promise<void>;
    /** Calls back on every change; returns the unsubscribe function. */
    subscribe(listener: (state: UpdateState) => void): () => void;
  };
}
declare global {
  interface Window {
    reviewerDesktop?: ReviewerDesktop;
  }
}
