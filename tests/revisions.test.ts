import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fixture, FixtureProvider } from './fixtures';
import { createApp } from '../server/app';
import { git } from '../server/process';
import { validateModelResult } from '../server/validation';
import { buildContext, type AnalysisInput } from '../server/provider';
import { emptyModelResult, type ReviewSession, type ReviewDraft } from '../shared/model';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Analysis did not finish');
}
describe('incremental review revisions', () => {
  it('retains the pinned review, reads old code, and passes only post-review changes and replies to the follow-up', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const inputs: AnalysisInput[] = [];
    let failNext = false;
    const delegate = new FixtureProvider();
    const { app, store } = createApp({
      dataDir: join(f.root, 'app'),
      github: f.github,
      provider: {
        id: 'incremental-fixture',
        async analyze(input, signal, progress) {
          inputs.push(input);
          if (failNext) throw new Error('Follow-up unavailable');
          const result = await delegate.analyze(input, signal, progress);
          if (input.followUp) {
            result.summary = 'Переписанное описание не должно заменить исходное ревью.';
            result.followUp = {
              summary: '### После ревью\nПлатёж вынесен.',
              items: [
                {
                  previousId: 'f1',
                  status: 'fixed',
                  summary: 'Удалён синхронный вызов.',
                  evidence: [result.findings[0].evidence[0]],
                },
              ],
            };
            result.findings = [];
          }
          return result;
        },
      },
    });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const session = (
      await request('POST', '/api/sessions', {
        title: 'Follow-up',
        repositories: [{ repoId: f.repo.id, prNumber: 12 }],
      })
    ).json<ReviewSession>();
    await request('POST', `/api/sessions/${session.id}/analyze`, {});
    await waitFor(() => store.session(session.id)?.run?.state === 'complete');
    const original = store.session(session.id)!;
    // API responses reference indexes instead of embedding them.
    const pinned = store.detachSession(original).run;
    const draft = (await request('GET', `/api/sessions/${session.id}/drafts`)).json<
      ReviewDraft[]
    >()[0];
    await request('PUT', `/api/sessions/${session.id}/drafts/${draft.snapshotId}`, {
      ...draft,
      body: 'Review question',
      comments: [
        {
          id: 'question',
          body: 'Как обрабатывается ошибка?',
          selected: true,
          evidence: original.run!.result.findings[0].evidence[0],
        },
      ],
    });
    const snapshotDirs = await readdir(join(f.root, 'app', 'snapshots'));
    const unchanged = (
      await request('POST', `/api/sessions/${session.id}/refresh`, {})
    ).json<ReviewSession>();
    expect(unchanged.run!.id).toBe(original.run!.id);
    expect(unchanged.snapshots[0].id).toBe(original.snapshots[0].id);
    expect(inputs).toHaveLength(1);
    expect(await readdir(join(f.root, 'app', 'snapshots'))).toEqual(snapshotDirs);
    const repeated = (await request('POST', `/api/sessions/${session.id}/analyze`, {})).json<
      ReviewSession['run']
    >();
    expect(repeated!.id).toBe(original.run!.id);
    expect(inputs).toHaveLength(1);
    expect(store.session(session.id)!.history).toBeUndefined();
    const path = 'src/main/java/example/OrderService.java';
    const code = await readFile(join(f.repo.path, path), 'utf8');
    await writeFile(
      join(f.repo.path, path),
      code.replace('    paymentClient.charge(order.id);\n', ''),
    );
    await git(f.repo.path, ['add', path]);
    await git(f.repo.path, ['commit', '-m', 'Remove synchronous payment']);
    const sha = (await git(f.repo.path, ['rev-parse', 'HEAD'])).trim();
    await git(f.repo.path, ['push', '--force', 'origin', `${sha}:refs/pull/12/head`]);
    f.github.pr = { ...f.pr, headRefOid: sha };
    f.github.comments = [
      {
        id: 'inline:reply',
        body: 'Исправил вызов платежа',
        author: 'author',
        url: `${f.pr.url}#reply`,
        at: '2099-01-01T00:00:00Z',
        updatedAt: '2099-01-01T00:00:00Z',
      },
    ];
    const refreshed = (
      await request('POST', `/api/sessions/${session.id}/refresh`, {})
    ).json<ReviewSession>();
    expect(refreshed.history).toHaveLength(1);
    expect(refreshed.history![0].run).toEqual(pinned);
    expect(refreshed.history![0].drafts[0].body).toBe('Review question');
    expect(refreshed.update!.changes[0].files.map((file) => file.path)).toEqual([path]);
    expect(refreshed.update!.discussion[0].body).toContain('Исправил');
    const oldCode = (
      await request(
        'GET',
        `/api/sessions/${session.id}/source?${new URLSearchParams({ repoId: f.repo.id, path, side: 'head', snapshotId: original.snapshots[0].id })}`,
      )
    ).json<{ text: string }>().text;
    const newCode = (
      await request(
        'GET',
        `/api/sessions/${session.id}/source?${new URLSearchParams({ repoId: f.repo.id, path, side: 'head' })}`,
      )
    ).json<{ text: string }>().text;
    expect(oldCode).toContain('paymentClient.charge');
    expect(newCode).not.toContain('paymentClient.charge');
    const carried = (await request('GET', `/api/sessions/${session.id}/drafts`)).json<
      ReviewDraft[]
    >()[0];
    expect(carried.body).toBe('Review question');
    expect(carried.comments[0]).toMatchObject({
      selected: false,
      outdated: true,
      origin: { snapshotId: original.snapshots[0].id },
    });
    expect(carried.comments[0].body).not.toContain('[Требуется перепроверка');
    await request('POST', `/api/sessions/${session.id}/analyze`, {});
    await waitFor(() => store.session(session.id)?.run?.state === 'complete');
    expect(inputs[1].followUp!.previousReviewId).toBe(original.run!.id);
    expect(inputs[1].followUp!.previous.findings[0].id).toBe('f1');
    expect(inputs[1].followUp!.comments[0].id).toBe('question');
    const context = JSON.parse((await buildContext(inputs[1])).text);
    expect(context.followUp.previousReviewId).toBe(original.run!.id);
    expect(context.snapshots[0].files.map((file: { path: string }) => file.path)).toEqual([path]);
    const completed = (await request('GET', `/api/sessions/${session.id}`)).json<ReviewSession>();
    expect(completed.run!.result.followUp!.items[0].status).toBe('fixed');
    expect(completed.run!.result.summary).toBe(original.run!.result.summary);
    expect(completed.run!.result.findings).toEqual([]);
    expect(
      completed.run!.result.followUp!.items.find((item) => item.previousId === 'question')?.status,
    ).toBe('unknown');
    expect(completed.history![0].run).toEqual(pinned);
    expect(completed.history![0].snapshots[0].headSha).toBe(f.pr.headRefOid);
    const after = (
      await request('POST', `/api/sessions/${session.id}/refresh`, {})
    ).json<ReviewSession>();
    expect(after.run!.id).toBe(completed.run!.id);
    expect(after.history).toHaveLength(1);
    f.github.comments.push({
      ...f.github.comments[0],
      id: 'inline:second-reply',
      body: 'Дополнительный ответ',
      updatedAt: '2099-01-02T00:00:00Z',
    });
    // A reply without code changes syncs the discussion but keeps the completed review.
    const replyOnly = (
      await request('POST', `/api/sessions/${session.id}/refresh`, {})
    ).json<ReviewSession>();
    expect(replyOnly.snapshots[0].id).toBe(completed.snapshots[0].id);
    expect(replyOnly.run!.id).toBe(completed.run!.id);
    expect(replyOnly.history).toHaveLength(1);
    expect(replyOnly.update).toEqual(after.update);
    expect(replyOnly.threadDiscussion?.map((comment) => comment.id)).toContain(
      'inline:second-reply',
    );
    // The next commit archives the completed follow-up and carries the unseen reply into it.
    await writeFile(
      join(f.repo.path, path),
      `${await readFile(join(f.repo.path, path), 'utf8')}// follow-up\n`,
    );
    await git(f.repo.path, ['commit', '-am', 'Follow-up commit']);
    const nextSha = (await git(f.repo.path, ['rev-parse', 'HEAD'])).trim();
    await git(f.repo.path, ['push', '--force', 'origin', `${nextSha}:refs/pull/12/head`]);
    f.github.pr = { ...f.pr, headRefOid: nextSha };
    const nextRevision = (
      await request('POST', `/api/sessions/${session.id}/refresh`, {})
    ).json<ReviewSession>();
    expect(nextRevision.history).toHaveLength(2);
    expect(nextRevision.update!.previousReviewId).toBe(completed.run!.id);
    expect(nextRevision.update!.changes[0].files.map((file) => file.path)).toEqual([path]);
    expect(nextRevision.update!.discussion.map((comment) => comment.id)).toEqual([
      'inline:second-reply',
    ]);
    failNext = true;
    await request('POST', `/api/sessions/${session.id}/analyze`, {});
    await waitFor(() => store.session(session.id)?.run?.state === 'partial');
    const failed = store.session(session.id)!;
    expect(store.detachSession(failed).history![1].run).toEqual(completed.run);
    expect(failed.history![1].snapshots).toEqual(completed.snapshots);
    expect(failed.run!.result.gaps.join()).toContain('Follow-up unavailable');
    await request('POST', `/api/sessions/${session.id}/analyze`, {});
    await waitFor(() => store.session(session.id)?.run?.state === 'partial');
    expect(store.session(session.id)!.history).toHaveLength(2);
    expect(inputs.at(-1)!.followUp!.previousReviewId).toBe(completed.run!.id);
  });
  it('downgrades a claimed fix when its current-code evidence is invalid', async () => {
    const result = await validateModelResult(
      {
        ...emptyModelResult(),
        followUp: {
          summary: 'Fix',
          items: [
            {
              previousId: 'f',
              status: 'fixed',
              summary: 'Claimed fixed',
              evidence: [
                { repoId: 'missing', side: 'head', path: 'missing.kt', startLine: 1, endLine: 1 },
              ],
            },
          ],
        },
      },
      [],
    );
    expect(result.followUp!.items[0]).toMatchObject({ status: 'unknown', evidence: [] });
  });
});
