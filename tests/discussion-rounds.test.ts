import { describe, expect, it } from 'vitest';
import { discussionRounds, reviewSummaryText } from '../shared/discussion-rounds';
import type { ReviewDiscussion } from '../shared/model';

const comment = (fields: Partial<ReviewDiscussion> & { id: string; at: string }) =>
  ({
    repoId: 'r',
    body: 'text',
    author: 'me',
    url: '',
    updatedAt: fields.at,
    ...fields,
  }) as ReviewDiscussion;

describe('comment history by GitHub review', () => {
  const first = [
    comment({ id: 'review:1', at: '2026-11-17T07:33:26Z', body: '<!-- free-solo-review:a -->' }),
    comment({ id: 'inline:11', at: '2026-11-17T07:33:26Z', reviewId: 1, originalCommitId: 'old' }),
    comment({ id: 'inline:12', at: '2026-11-17T07:33:26Z', reviewId: 1, originalCommitId: 'old' }),
  ];
  const reply = comment({
    id: 'inline:13',
    at: '2026-11-17T08:04:45Z',
    reviewId: 3,
    replyTo: 'inline:12',
    author: 'author',
  });
  const second = [
    comment({
      id: 'review:2',
      at: '2026-11-17T10:26:08Z',
      body: 'Looks better\n<!-- free-solo-review:b -->',
    }),
    comment({
      id: 'inline:21',
      at: '2026-11-17T10:26:08Z',
      reviewId: 2,
      commitId: 'new',
      originalCommitId: 'new',
    }),
  ];
  const talk = comment({ id: 'comment:31', at: '2026-11-17T09:00:00Z', author: 'author' });
  const all = [...first, reply, ...second, talk];
  const items = [first[1], first[2], second[0], second[1], talk].map((root) => ({ root }));

  it('puts each comment under the review it was sent in, newest review first', () => {
    const rounds = discussionRounds(items, all);
    expect(rounds.map((round) => [round.id, round.number, round.commitId])).toEqual([
      ['review:2', 2, 'new'],
      ['review:1', 1, 'old'],
      ['conversation', undefined, undefined],
    ]);
    expect(rounds[0].items.map((item) => item.root.id)).toEqual(['review:2', 'inline:21']);
    expect(rounds[1].items.map((item) => item.root.id)).toEqual(['inline:11', 'inline:12']);
    expect(rounds[1].at).toBe('2026-11-17T07:33:26Z');
    expect(rounds[2].items.map((item) => item.root.id)).toEqual(['comment:31']);
  });
  it('does not count a reply, which GitHub files as a review of its own, as a round', () => {
    expect(discussionRounds(items, all).find((round) => round.id === 'review:3')).toBeUndefined();
    expect(discussionRounds(items, all)[0].number).toBe(2);
  });
  it('hides the marker Reviewer puts into the review body', () => {
    expect(reviewSummaryText(first[0].body)).toBe('');
    expect(reviewSummaryText(second[0].body)).toBe('Looks better');
  });
});
