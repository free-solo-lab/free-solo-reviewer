import { describe, expect, it } from 'vitest';
import { inlineLocation } from '../server/repository.js';
import { reviewFixture } from './core-fixtures.js';
describe('review publishing', () => {
  it('continues on the same commit for approval and more comments without resending previous messages', async () => {
    const f = await reviewFixture();
    const initial = f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      comments: [
        { id: 'first', body: 'First published comment', evidence: f.evidence, selected: true },
        { id: 'later', body: 'Not selected yet', evidence: f.evidence, selected: false },
        {
          id: 'codex',
          body: 'Task for Codex',
          evidence: f.evidence,
          selected: false,
          forCodex: true,
        },
      ],
    });
    await f.manager.publish(f.session, f.snapshot);
    const next = f.manager.continue(f.session, f.snapshot);
    expect(next.state).toBe('draft');
    expect(next.round).toBeTruthy();
    expect(next.body).toBe('');
    expect(next.comments.map((comment) => comment.id)).toEqual(['later', 'codex']);
    expect(next.published?.[0].comments.map((comment) => comment.id)).toEqual(['first']);
    expect(f.manager.continue(f.session, f.snapshot).round).toBe(next.round);
    expect(() => f.manager.save(f.session, f.snapshot, initial)).toThrow('уже отправлено');
    expect(() =>
      f.manager.save(f.session, f.snapshot, { ...next, comments: initial.comments }),
    ).toThrow('повторно');
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('уже отправлено');
    f.manager.save(f.session, f.snapshot, { ...next, action: 'APPROVE' });
    await f.manager.publish(f.session, f.snapshot, next.round);
    await f.manager.publish(f.session, f.snapshot, next.round);
    expect(f.github.submissions).toHaveLength(2);
    expect(f.github.submissions[1]).toMatchObject({ event: 'APPROVE', comments: [] });
    const third = f.manager.continue(f.session, f.snapshot);
    f.manager.save(f.session, f.snapshot, {
      ...third,
      comments: third.comments.map((comment) => ({ ...comment, selected: comment.id === 'later' })),
    });
    await f.manager.publish(f.session, f.snapshot, third.round);
    expect(f.github.submissions).toHaveLength(3);
    expect(f.github.submissions[2].comments.map((comment) => comment.body)).toEqual([
      'Not selected yet',
    ]);
    const active = f.manager.continue(f.session, f.snapshot);
    expect(active.published).toHaveLength(3);
    expect(active.comments.map((comment) => comment.id)).toEqual(['codex']);
  });
  it('does not create a new review while the previous publication outcome is unknown', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
    });
    f.github.throwBeforeSubmit = true;
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('не подтвердил');
    expect(() => f.manager.continue(f.session, f.snapshot)).toThrow('сверку');
    expect(f.github.submissions).toHaveLength(0);
  });
  for (const state of ['cancelled', 'failed', 'running', 'none'] as const)
    it(`allows manually prepared comments when analysis is ${state}`, async () => {
      const f = await reviewFixture();
      if (state === 'none') f.session.run = null;
      else f.session.run!.state = state;
      f.manager.save(f.session, f.snapshot, {
        ...f.manager.get(f.session, f.snapshot),
        comments: [
          { id: 'manual', body: 'Manual review comment', evidence: f.evidence, selected: true },
        ],
      });
      expect((await f.manager.publish(f.session, f.snapshot)).state).toBe('submitted');
      expect(f.github.submissions[0].comments).toHaveLength(1);
    });

  for (const action of ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const)
    it(`publishes ${action} with explicit head and correct inline location`, async () => {
      const f = await reviewFixture();
      let draft = f.manager.get(f.session, f.snapshot);
      draft = f.manager.save(f.session, f.snapshot, {
        ...draft,
        body: 'Reviewed',
        action,
        comments: [{ id: 'c', body: 'Check compensation', evidence: f.evidence, selected: true }],
      });
      const published = await f.manager.publish(f.session, f.snapshot);
      expect(published.state).toBe('submitted');
      expect(f.github.submissions[0]).toMatchObject({
        event: action,
        commit_id: f.pr.headRefOid,
        comments: [
          {
            path: f.evidence.path,
            line: f.evidence.startLine,
            side: 'RIGHT',
            body: 'Check compensation',
          },
        ],
      });
      await f.manager.publish(f.session, f.snapshot);
      expect(f.github.submissions).toHaveLength(1);
    });
  it('supports LEFT comments, context comments and deselection', async () => {
    const f = await reviewFixture();
    const openapi = f.snapshot.files.find((f) => f.path === 'openapi.yaml')!;
    const ref = {
      repoId: f.repo.id,
      side: 'base' as const,
      path: 'openapi.yaml',
      startLine: openapi.removedLines[0],
      endLine: openapi.removedLines[0],
    };
    expect(inlineLocation(f.snapshot, ref)?.side).toBe('LEFT');
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
      comments: [
        { id: 'l', body: 'Removed', evidence: ref, selected: true },
        { id: 'g', body: 'General', evidence: null, selected: true },
        { id: 'skip', body: 'Skip', evidence: null, selected: false },
      ],
    });
    await f.manager.publish(f.session, f.snapshot);
    expect(f.github.submissions[0].comments[0].side).toBe('LEFT');
    expect(f.github.submissions[0].body).toContain('General');
    expect(f.github.submissions[0].body).not.toContain('Skip');
  });
  it('blocks stale PRs and invalidates self approval', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
      action: 'APPROVE',
    });
    f.github.changed = true;
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('новые коммиты');
    expect(f.github.submissions).toHaveLength(0);
    f.github.changed = false;
    f.github.login = 'author';
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('собственного PR');
  });
  it('reconciles accepted request after timeout without duplicate publication', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
    });
    f.github.throwAfterSubmit = true;
    expect((await f.manager.publish(f.session, f.snapshot)).state).toBe('submitted');
    await f.manager.publish(f.session, f.snapshot);
    expect(f.github.submissions).toHaveLength(1);
  });
  it('persists uncertainty and refuses blind retry when outcome cannot be established', async () => {
    const f = await reviewFixture();
    f.manager.save(f.session, f.snapshot, {
      ...f.manager.get(f.session, f.snapshot),
      body: 'Review',
    });
    f.github.throwBeforeSubmit = true;
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('не подтвердил');
    expect(f.manager.get(f.session, f.snapshot).state).toBe('uncertain');
    await expect(f.manager.publish(f.session, f.snapshot)).rejects.toThrow('Результат предыдущей');
    expect(f.github.submissions).toHaveLength(0);
  });
});
