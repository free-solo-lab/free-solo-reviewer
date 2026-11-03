import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { reviewPoints, selectedReviewRange } from '../shared/review-timeline';
import {
  emptyModelResult,
  type ReviewSession,
  type Snapshot,
  type ReviewRevision,
} from '../shared/model';
import { ReviewTimeline, timelineSelection } from '../web/layout/ReviewTimeline';

const snapshot = (id: string, headSha = id, baseRef = 'origin/master') =>
  ({
    id,
    repoId: 'repo',
    repoName: 'Service',
    headSha,
    mergeBase: 'base',
    local: { baseRef },
    files: [],
    headFiles: [],
    baseFiles: [],
  }) as unknown as Snapshot;
const revision = (id: string, headSha = id): ReviewRevision =>
  ({
    id,
    savedAt: '2026-11-01T08:00:00Z',
    snapshots: [snapshot(id, headSha)],
    drafts: [],
    run: { id, state: 'complete', result: { ...emptyModelResult(), indexes: [], contracts: [] } },
  }) as unknown as ReviewRevision;
const makeSession = (history: ReviewRevision[] = []) =>
  ({
    id: 'session',
    createdAt: '2026-10-29T00:00:00Z',
    snapshots: [snapshot('latest')],
    run: null,
    history,
  }) as ReviewSession;

describe('review comparison timeline', () => {
  it('starts with the pinned base, ends at the current code, and defaults to the last reviewed source', () => {
    const session = makeSession([revision('first'), revision('second')]);
    const selected = selectedReviewRange(session);
    expect(selected.points.map((p) => p.id)).toEqual(['base', 'first', 'second', 'current']);
    expect(selected.from.id).toBe('second');
    expect(selected.to?.id).toBe('current');
    expect(selected.points[0].snapshots[0].id).toBe('first');
    expect(selectedReviewRange(session, 'base', 'first').to?.id).toBe('current');
  });
  it('never turns discussion-only reanalysis, empty failures, running jobs or another base into selectable stages', () => {
    const duplicate = revision('renamed', 'first');
    const running = revision('running');
    running.run.state = 'running';
    const failure = revision('failure');
    failure.run.state = 'failed';
    const scope = revision('head-only');
    scope.snapshots = [snapshot('head-only', 'head-only', 'HEAD')];
    const session = makeSession([
      revision('first'),
      duplicate,
      running,
      failure,
      scope,
      revision('same-as-current', 'latest'),
    ]);
    expect(reviewPoints(session).map((p) => p.id)).toEqual(['base', 'renamed', 'current']);
    expect(reviewPoints(session)[0].snapshots[0].id).toBe('first');
    session.threadDiscussion = [];
    session.discussionRevision = 'new-comments';
    expect(reviewPoints(session).map((p) => p.id)).toEqual(['base', 'renamed', 'current']);
  });
  it('can return to the initial base without an analysis and interprets old version links as a baseline', () => {
    expect(selectedReviewRange(makeSession()).from.id).toBe('base');
    const session = makeSession([revision('first'), revision('second')]);
    expect(selectedReviewRange(session, undefined, 'first').from.id).toBe('first');
    expect(selectedReviewRange(session, 'unknown').from.id).toBe('second');
  });
  it('adds no stage when a review is sent on the current code, only once new commits arrive', () => {
    const session = makeSession();
    const sent = (id: string, snapshotId: string) => ({
      id,
      key: id,
      at: '2026-11-02T21:03:00Z',
      kind: 'github' as const,
      repoId: 'repo',
      snapshotIds: [snapshotId],
      commentIds: [],
    });
    session.workflow = {
      version: 1,
      initial: { at: session.createdAt, snapshots: [snapshot('initial')] },
      versions: [],
      checkpoints: [sent('review-1', 'latest')],
    };
    const published = selectedReviewRange(session);
    expect(published.points.map((p) => p.id)).toEqual(['base', 'current']);
    expect(published.from.id).toBe('base');
    expect(selectedReviewRange(session, 'review-1').from.id).toBe('base');

    // The author pushed: the sent review becomes the stage to compare with.
    session.workflow.versions = [snapshot('latest')];
    session.snapshots = [snapshot('newer')];
    const updated = selectedReviewRange(session);
    expect(updated.points.map((p) => p.id)).toEqual(['base', 'review-1', 'current']);
    expect(updated.from.id).toBe('review-1');
  });
  it('marks your approval on the reviewed code and asks to review again after it changes', () => {
    const session = makeSession();
    const review = (id: string, at: string, action: 'APPROVE' | 'COMMENT') => ({
      id,
      key: id,
      at,
      kind: 'github' as const,
      repoId: 'repo',
      snapshotIds: ['latest'],
      commentIds: [],
      action,
    });
    session.workflow = {
      version: 1,
      initial: { at: session.createdAt, snapshots: [snapshot('initial')] },
      versions: [],
      // A comment after the approval keeps it, as on GitHub.
      checkpoints: [
        review('approve', '2026-11-03T10:00:00Z', 'APPROVE'),
        review('comment', '2026-11-03T11:00:00Z', 'COMMENT'),
      ],
    };
    const render = () => {
      const selected = selectedReviewRange(session);
      return renderToStaticMarkup(
        React.createElement(ReviewTimeline, {
          points: selected.points,
          from: selected.from.id,
          onChange: async () => {},
        }),
      );
    };
    const tones = () => [...render().matchAll(/data-tone="([a-z]+)"/g)].map((m) => m[1]);
    expect(reviewPoints(session).at(-1)?.decision).toBe('APPROVE');
    expect(tones()).toEqual(['approved']);
    expect(render()).toContain('Вы одобрили эту версию');

    session.workflow.versions = [snapshot('latest')];
    session.snapshots = [snapshot('newer')];
    const points = reviewPoints(session);
    expect(points.map((p) => [p.id, p.decision])).toEqual([
      ['base', undefined],
      ['comment', 'APPROVE'],
      ['current', undefined],
    ]);
    expect(tones()).toEqual(['approved', 'stale']);
    expect(render()).toContain('Код изменился после вашего апрува');
  });
  it('marks versions you only commented on', () => {
    const session = makeSession();
    session.workflow = {
      version: 1,
      initial: { at: session.createdAt, snapshots: [snapshot('initial')] },
      versions: [snapshot('latest')],
      checkpoints: [
        {
          id: 'note',
          key: 'note',
          at: '2026-11-03T10:00:00Z',
          kind: 'github',
          repoId: 'repo',
          snapshotIds: ['latest'],
          commentIds: [],
          action: 'COMMENT',
        },
      ],
    };
    session.snapshots = [snapshot('newer')];
    expect(reviewPoints(session).map((p) => p.decision)).toEqual([undefined, 'COMMENT', undefined]);
    const selected = selectedReviewRange(session);
    const html = renderToStaticMarkup(
      React.createElement(ReviewTimeline, {
        points: selected.points,
        from: selected.from.id,
        onChange: async () => {},
      }),
    );
    expect([...html.matchAll(/data-tone="([a-z]+)"/g)].map((m) => m[1])).toEqual(['comment']);
    expect(html).toContain('Вы отправили комментарии к этой версии');
  });
  it('renders one movable boundary with names above the track and dates below, with no version dropdown', () => {
    const selected = selectedReviewRange(makeSession([revision('first')]));
    const html = renderToStaticMarkup(
      React.createElement(ReviewTimeline, {
        points: selected.points,
        from: selected.from.id,
        onChange: async () => {},
      }),
    );
    expect(html.match(/type="range"/g)).toHaveLength(1);
    expect(html).not.toContain('<select');
    expect(html).toContain('Текущая версия');
    expect(html).toContain('origin/master');
    expect(html.indexOf('Анализ 1')).toBeLessThan(html.indexOf('type="range"'));
    expect(html.indexOf('<time')).toBeGreaterThan(html.indexOf('type="range"'));
  });
});

it('resets a preview from another review synchronously when the new timeline has fewer points', () => {
  const old = ['base', 'analysis-1', 'analysis-2', 'review-3', 'current'].map((id) => ({ id }));
  const oldChoice = timelineSelection(old, 'review-3');
  expect(oldChoice.index).toBe(3);
  const short = ['base', 'current'].map((id) => ({ id }));
  expect(timelineSelection(short, 'base', oldChoice).index).toBe(0);
  expect(timelineSelection(short, 'missing', oldChoice).index).toBe(0);
  const current = timelineSelection(short, 'base');
  expect(timelineSelection(short, 'base', { ...current, index: 5 }).index).toBe(0);
});
