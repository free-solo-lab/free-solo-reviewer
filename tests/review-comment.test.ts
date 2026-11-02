import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { acceptedFix, commentSource, commentSteps, commentTitle } from '../shared/review-comment';
import type { DraftComment, ReviewSession } from '../shared/model';
import { ReviewCommentRow } from '../web/dialogs/ReviewCommentRow';
import { TooltipProvider } from '../web/ui/Tooltip';
import { reviewFixture } from './core-fixtures';

const comment: DraftComment = {
  id: 'a',
  body: '[Требуется перепроверка после обновления PR]\nРасширить обработку через наследование, сохранив прежнюю реализацию.',
  selected: false,
  forCodex: true,
  evidence: {
    repoId: 'repo',
    path: 'src/LongClassName.java',
    side: 'head',
    startLine: 15,
    endLine: 20,
  },
};
it('keeps compact excerpts separate from the unchanged source comment', () => {
  expect(commentTitle(comment.body)).toBe(
    'Расширить обработку через наследование, сохранив прежнюю реализацию.',
  );
  expect(commentTitle('Long comment '.repeat(100)).length).toBeLessThanOrEqual(100);
  expect(comment.body).toContain('[Требуется перепроверка');
  const html = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ReviewCommentRow, { comment, onCode() {} }),
    ),
  );
  expect(html).toContain('Последовательность действий');
  expect(html).toContain('Код к этому замечанию');
  expect(html).not.toContain('LongClassName.java');
  expect(html).not.toContain('Требуется перепроверка');
  expect(html).not.toContain('<textarea');
});
it('does not invent reviewer acceptance or timestamps for legacy completion', () => {
  const completion = {
    repoId: 'repo',
    commentId: 'a',
    body: comment.body,
    at: '2026-11-02T10:00:00Z',
  };
  expect(commentSteps(comment, completion)).toEqual([
    { actor: 'reviewer', action: 'comment' },
    { actor: 'codex', action: 'done', at: completion.at },
  ]);
  expect(acceptedFix(comment, completion)).toBe(false);
  expect(
    commentSteps(comment, { ...completion, skipped: true }).some((s) => s.actor === 'codex'),
  ).toBe(false);
});
it('retains Codex completion in the chain when the comment returns to the human review', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ReviewCommentRow, {
        comment: { ...comment, forCodex: false },
        onChange() {},
        completion: { repoId: 'repo', commentId: 'a', body: comment.body },
      }),
    ),
  );
  expect(html).toContain('Codex');
  expect(html).toContain('выполнено');
  expect(html).toContain('Ожидает вашей проверки');
  expect(html).not.toContain('Исправление проверено');
});
it('opens original code for outdated comments and an exact archived version for publications', () => {
  const s = {
    snapshots: [{ id: 'current', repoId: 'repo' }],
    history: [{ id: 'analysis-1', snapshots: [{ id: 'old', repoId: 'repo' }] }],
  } as ReviewSession;
  expect(commentSource(s, comment, 'old')?.versionId).toBe('analysis-1');
  const original = {
    ...comment,
    outdated: true,
    origin: { snapshotId: 'old', evidence: { ...comment.evidence!, startLine: 3 } },
  };
  expect(commentSource(s, original, 'current')).toEqual({
    evidence: original.origin.evidence,
    versionId: 'analysis-1',
  });
  expect(commentSource(s, comment, 'missing')).toBeUndefined();
  expect(commentSource(s, comment, 'current')?.versionId).toBe('current');
});
it('records only real handoffs, preserves acceptance through autosaves, and never calls a model', async () => {
  const f = await reviewFixture();
  let draft = f.manager.save(f.session, f.snapshot, {
    ...f.manager.get(f.session, f.snapshot),
    comments: [{ ...comment, evidence: f.evidence }],
  });
  expect(draft.comments[0].activity?.map((e) => e.action)).toEqual(['created', 'codex']);
  const original = structuredClone(draft);
  draft = f.manager.save(f.session, f.snapshot, draft);
  expect(draft.comments[0].activity).toEqual(original.comments[0].activity);
  expect(() => f.manager.acceptFix(f.session, f.snapshot, 'a')).toThrow('недоступно');
  f.store.saveFixChat({
    sessionId: f.session.id,
    repoId: f.snapshot.repoId,
    snapshotId: f.snapshot.id,
    state: 'complete',
    turnId: 'turn',
    commentsHash: '',
    events: [],
    completedSteps: [
      { repoId: f.snapshot.repoId, commentId: 'a', body: comment.body, at: '2026-11-02T10:00:00Z' },
    ],
  });
  const accepted = f.manager.acceptFix(f.session, f.snapshot, 'a');
  const completion = f.store.fixChat(f.session.id)!.completedSteps![0];
  expect(acceptedFix(accepted.comments[0], completion)).toBe(true);
  expect(f.manager.acceptFix(f.session, f.snapshot, 'a').comments[0].activity).toEqual(
    accepted.comments[0].activity,
  );
  const saved = f.manager.save(f.session, f.snapshot, original);
  expect(acceptedFix(saved.comments[0], completion)).toBe(true);
  expect(f.github.submissions).toHaveLength(0);
});
