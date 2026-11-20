import { describe, expect, it, vi } from 'vitest';
import { GitHub } from '../server/github';
import { sessionListItem } from '../shared/session-list';
import { discussionRounds } from '../shared/discussion-rounds';
import { ensureReviewWorkflow } from '../shared/review-workflow';
import type { ReviewDiscussion, ReviewSession, Snapshot } from '../shared/model';

describe('approvals and merges made on GitHub', () => {
  it('reads every reviewer’s latest decision, including an approval without text', async () => {
    const github = new GitHub();
    vi.spyOn(github, 'api').mockResolvedValue({
      data: {
        repository: {
          pullRequest: {
            state: 'MERGED',
            // GitHub keeps asking for a review when a PR is merged without the required one.
            reviewDecision: 'REVIEW_REQUIRED',
            headRefOid: 'head',
            latestOpinionatedReviews: {
              nodes: [
                {
                  databaseId: 7,
                  state: 'APPROVED',
                  submittedAt: '2026-11-17T12:20:00Z',
                  author: { login: 'lead' },
                  commit: { oid: 'head' },
                },
                { databaseId: 8, state: 'DISMISSED', submittedAt: '', author: null, commit: null },
              ],
            },
          },
        },
      },
    } as never);
    expect(await github.remoteState('org/repo', 61)).toEqual({
      state: 'merged',
      headSha: 'head',
      decision: 'review_required',
      reviews: [
        { id: 7, author: 'lead', state: 'approved', at: '2026-11-17T12:20:00Z', commitId: 'head' },
      ],
    });
  });

  it('shows a merged or closed PR as finished in the review list', () => {
    const session: ReviewSession = {
      id: 'review',
      title: 'Orders',
      createdAt: '2026-11-01T10:00:00Z',
      snapshots: [
        {
          id: 's',
          repoId: 'repo',
          repoName: 'Orders',
          headSha: 'head',
          pr: { number: 61 },
        } as Snapshot,
      ],
      run: null,
    };
    const remote = (state: 'open' | 'closed' | 'merged') =>
      (ensureReviewWorkflow(session).remote = [
        { repoId: 'repo', number: 61, headSha: 'head', state, decision: 'unknown', at: '' },
      ]);
    remote('open');
    expect(sessionListItem(session).reviewState).toBe('new');
    remote('merged');
    expect(sessionListItem(session).reviewState).toBe('merged');
    remote('closed');
    expect(sessionListItem(session).reviewState).toBe('closed');
  });

  it('lists an approval without comments as its own review in the history', () => {
    const comment: ReviewDiscussion = {
      id: 'inline:1',
      repoId: 'repo',
      body: 'Fix this',
      author: 'me',
      url: '',
      at: '2026-11-17T07:33:26Z',
      updatedAt: '',
      reviewId: 5,
    };
    const rounds = discussionRounds(
      [{ root: comment }],
      [comment],
      [
        { id: 7, author: 'lead', state: 'approved', at: '2026-11-17T12:20:00Z', commitId: 'head' },
        { id: 5, author: 'me', state: 'changes_requested', at: '2026-11-17T07:33:26Z' },
      ],
    );
    expect(
      rounds.map((round) => [round.number, round.author, round.decision, round.items.length]),
    ).toEqual([
      [2, 'lead', 'approved', 0],
      [1, 'me', 'changes_requested', 1],
    ]);
  });
});
