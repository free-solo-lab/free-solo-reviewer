import { describe, expect, it } from 'vitest';
import { comparisonReview, displayedRevision } from '../shared/review-display';
import type { ReviewSession } from '../shared/model';
const session = (scopeChanged: boolean, previousReviewId?: string) =>
  ({
    run: { previousReviewId },
    update: { scopeChanged, previousReviewId: 'old' },
    history: [{ id: 'old' }, { id: 'review-of-new-base' }],
  }) as unknown as ReviewSession;
describe('comparison baseline for review markers', () => {
  it('does not treat the first analysis after switching HEAD to master as fixes to an unrelated review', () => {
    expect(comparisonReview(session(true))).toBeUndefined();
    expect(displayedRevision(session(true))).toBeUndefined();
    expect(displayedRevision(session(true), 'old')?.id).toBe('old');
  });
  it('retains markers for ordinary updates and explicit follow-up baselines', () => {
    expect(comparisonReview(session(false))?.id).toBe('old');
    expect(comparisonReview(session(true, 'review-of-new-base'))?.id).toBe('review-of-new-base');
  });
});

describe('version shown by default after a re-review', () => {
  it('keeps the review while updates wait for analysis and shows the analyzed updates after', () => {
    const pending = {
      run: { result: {} },
      update: { scopeChanged: false, previousReviewId: 'old' },
      history: [{ id: 'old' }],
    } as unknown as ReviewSession;
    expect(displayedRevision(pending)?.id).toBe('old');
    const analyzed = {
      ...pending,
      run: { result: { followUp: { summary: '', items: [] } } },
    } as unknown as ReviewSession;
    expect(displayedRevision(analyzed)).toBeUndefined();
    expect(displayedRevision(analyzed, 'old')?.id).toBe('old');
  });
});
