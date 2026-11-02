import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ReviewDraft } from '../shared/model';
const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../web/workspace/state', () => ({ useWorkspace: () => state.value }));
vi.mock('../web/queries', () => ({ useFixCompletions: () => [] }));
vi.mock('../web/ui/Dialog', async () => {
  const React = await import('react');
  return {
    Dialog: ({ children }: { children: React.ReactNode }) =>
      React.createElement('section', null, children),
    DialogTitle: ({ children }: { children: React.ReactNode }) =>
      React.createElement('h2', null, children),
    DialogClose: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});
import { ReviewDialog } from '../web/dialogs/ReviewDialog';
import { Topbar } from '../web/layout/Topbar';
import { TooltipProvider } from '../web/ui/Tooltip';

const snapshot = {
  id: 'snap',
  repoId: 'repo',
  repoName: 'Repo',
  headSha: 'abc',
  pr: { number: 1 },
  files: [],
  headFiles: [],
  baseFiles: [],
};
const draft: ReviewDraft = {
  sessionId: 's',
  snapshotId: 'snap',
  headSha: 'abc',
  round: 'next',
  state: 'draft',
  action: 'COMMENT',
  body: '',
  attempt: null,
  submission: null,
  comments: [{ id: 'new', body: 'New message', selected: true, evidence: null }],
  published: [
    {
      snapshotId: 'snap',
      headSha: 'abc',
      action: 'COMMENT',
      body: '',
      comments: [{ id: 'old', body: 'Previously published', selected: true, evidence: null }],
      submission: { id: 1, url: 'https://github.com/example/review/1', at: '2026-10-27T00:00:00Z' },
    },
  ],
};
function setup() {
  const session = { id: 's', title: 'Review', snapshots: [snapshot], history: [] };
  state.value = {
    session,
    sessionData: session,
    currentSnapshot: snapshot,
    reviewRepo: snapshot.id,
    drafts: [draft],
    busy: '',
    liveRun: { state: 'complete' },
    openReview: vi.fn(),
    canAnalyze: false,
  };
}
it('places Review with the pending count in the top toolbar instead of the search button', () => {
  setup();
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(Topbar)),
  );
  expect(html).toContain('Ревью');
  expect(html).toContain('>1</span>');
  expect(html).not.toContain('Поиск класса');
  expect(html).not.toContain('Черновик');
});
it('offers to leave a review when no comment is pending', () => {
  setup();
  state.value.drafts = [{ ...draft, comments: [] }];
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(Topbar)),
  );
  expect(html).toContain('Ревью');
  expect(html).not.toContain('_reviewCount');
});
it('keeps approval and new comments available alongside the collapsed publication history', () => {
  setup();
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(ReviewDialog)),
  );
  expect(html).toContain('История');
  expect(html).not.toContain('Previously published');
  expect(html).toContain('New message');
  expect(html).toContain('value="APPROVE"');
  expect(html).toContain('Отправить ревью');
  expect(html).toContain('Общий комментарий к ревью');
  expect(html.match(/<textarea/g)).toHaveLength(1);
  expect(html).not.toContain('<fieldset class="draft-panel" disabled');
});
it('opens the Codex steps from the Codex button, which is there before any step exists', () => {
  setup();
  state.value.drafts = [{ ...draft, comments: [] }];
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(Topbar)),
  );
  expect(html).toContain('Шаги для Codex: запуск исправлений по замечаниям ревью');
});
it('lists only Codex steps on their tab and leads to a waiting question', () => {
  setup();
  state.value.drafts = [
    {
      ...draft,
      comments: [
        ...draft.comments,
        { id: 'task', body: 'Add a timeout', selected: false, forCodex: true, evidence: null },
      ],
    },
  ];
  state.value.reviewView = 'codex';
  state.value.currentFixAttention = { sessionId: 's', kind: 'question' };
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(ReviewDialog)),
  );
  expect(html).toContain('Add a timeout');
  expect(html).not.toContain('New message');
  expect(html).toContain('Codex ждёт вашего ответа');
});
