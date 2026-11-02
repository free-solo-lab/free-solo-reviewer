import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyModelResult, type ReviewSession, type Snapshot } from '../shared/model';
import { sessionListItem } from '../shared/session-list';
import { recordReviewCheckpoint } from '../shared/review-workflow';
import { ReviewListItem } from '../web/layout/ReviewListItem';
import { TooltipProvider } from '../web/ui/Tooltip';

function session(local = false): ReviewSession {
  const snapshot = {
    id: 'source-1',
    repoId: 'repo',
    repoName: 'Orders',
    headSha: 'sha-1',
    contentHash: 'code-1',
    pr: local ? null : { number: 12, headRefName: 'feature' },
    ...(local && { local: { branchName: 'feature', baseRef: 'origin/master' } }),
  } as Snapshot;
  return {
    id: 'review',
    title: 'Orders review',
    createdAt: '2026-11-01T10:00:00Z',
    snapshots: [snapshot],
    run: null,
  };
}
function analyzed(
  s: ReviewSession,
  state: NonNullable<ReviewSession['run']>['state'] = 'complete',
) {
  s.run = {
    id: 'analysis',
    sessionId: s.id,
    state,
    version: 'test',
    fingerprint: 'f',
    startedAt: '2026-11-01T11:00:00Z',
    events: [],
    result: { ...emptyModelResult(), contracts: [], indexes: [] },
  };
  return s;
}
const sent = (s: ReviewSession, kind: 'github' | 'local' = 'github', repo = 'repo') =>
  recordReviewCheckpoint(s, repo, `sent:${repo}`, kind, [], '2026-11-01T12:00:00Z');

describe('review list states', () => {
  it('distinguishes a technical analysis from a human submission', () => {
    const s = session();
    expect(sessionListItem(s)).toMatchObject({
      reviewState: 'new',
      source: 'pr',
      pullRequests: [{ number: 12 }],
    });
    analyzed(s);
    expect(sessionListItem(s).reviewState).toBe('ready');
    sent(s);
    expect(sessionListItem(s)).toMatchObject({
      reviewState: 'sent',
      updatedAt: '2026-11-01T12:00:00Z',
    });
  });
  it('keeps a sent mark after empty commits but removes it when the reviewed code changes', () => {
    const s = analyzed(session());
    sent(s);
    s.snapshots = [{ ...s.snapshots[0], id: 'source-2', headSha: 'rebased' }];
    expect(sessionListItem(s).reviewState).toBe('sent');
    s.snapshots = [{ ...s.snapshots[0], id: 'source-3', contentHash: 'changed-code' }];
    expect(sessionListItem(s).reviewState).toBe('ready');
    s.run = null;
    expect(sessionListItem(s).reviewState).toBe('new');
  });
  it('distinguishes local packets from GitHub submissions, including after creating a PR', () => {
    const s = session(true);
    sent(s, 'local');
    expect(sessionListItem(s)).toMatchObject({
      source: 'local',
      reviewState: 'local-sent',
      branches: ['feature'],
    });
    s.snapshots[0] = { ...s.snapshots[0], pr: session().snapshots[0].pr };
    expect(sessionListItem(s)).toMatchObject({ source: 'pr', reviewState: 'local-sent' });
  });
  it('does not mark a project sent while another reviewed repository has no checkpoint', () => {
    const s = analyzed(session());
    s.snapshots.push({ ...s.snapshots[0], id: 'second', repoId: 'another' });
    sent(s);
    expect(sessionListItem(s).reviewState).toBe('ready');
    sent(s, 'github', 'another');
    expect(sessionListItem(s).reviewState).toBe('sent');
  });
  it('keeps running, partial, failed and stopped states distinct', () => {
    for (const state of ['running', 'partial', 'failed', 'cancelled'] as const) {
      const s = analyzed(session(), state);
      expect(sessionListItem(s).reviewState).toBe(state);
    }
    const s = analyzed(session(), 'running');
    sent(s);
    expect(sessionListItem(s).reviewState).toBe('running');
  });
});

describe('compact review row', () => {
  const render = (s: ReviewSession, needsAnswer = false) =>
    renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ReviewListItem, {
          item: sessionListItem(s),
          selected: true,
          needsAnswer,
          deleteDisabled: false,
          onOpen: vi.fn(),
          onDelete: vi.fn(),
        }),
      ),
    );
  it('shows source metadata and an accessible state icon without a visible state caption', () => {
    const s = analyzed(session());
    sent(s);
    const markup = render(s);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Ревью отправлено"');
    expect(markup).toContain('PR #12');
    expect(markup.replace(/<[^>]*>/g, '')).not.toContain('Ревью отправлено');
    expect(render(session(true))).toContain('Локально');
  });
  it('keeps questions from Codex visible in the state position', () => {
    expect(render(session(), true)).toContain('aria-label="Codex ждёт вашего ответа"');
  });
});
