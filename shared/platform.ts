/** Small native adapter; the review UI and API remain identical in both launch modes. */
export interface ReviewerDesktop {
  readonly platform: 'desktop';
  chooseDirectory(): Promise<string | null>;
}
declare global {
  interface Window {
    reviewerDesktop?: ReviewerDesktop;
  }
}
