import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../server/process';
import {
  connectRepository,
  createLocalSnapshot,
  readSource,
  workingSources,
  defaultLocalBase,
} from '../server/repository';
import { createApp as createServer } from '../server/app';
const createApp = (options: Parameters<typeof createServer>[0]) =>
  createServer({
    provider: { id: 'local-test-analysis', analyze: async () => emptyModelResult() },
    ...options,
  });
import { decodeFixResponse, type FixProvider } from '../server/fix-chat';
import type { FixChat } from '../shared/fix-chat';
import {
  emptyModelResult,
  type ReviewSession,
  type ReviewDraft,
  type PullRequest,
  type RepositoryBranches,
} from '../shared/model';
import { FakeGitHub } from './fixtures';
import type { Store } from '../server/store';

/** The refresh after a fix snapshots and indexes real Git repositories; a busy machine needs more than a second. */
async function afterFixRefresh(store: Store, sessionId: string) {
  await vi.waitFor(() => expect(store.fixChat(sessionId)?.postFix?.state).toBe('complete'), {
    timeout: 10_000,
  });
  await vi.waitFor(() => expect(store.session(sessionId)?.run?.state).not.toBe('running'), {
    timeout: 10_000,
  });
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'local-review-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.name', 'Local test']);
  await git(path, ['config', 'user.email', 'test@localhost']);
  await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 1; } }\n');
  await writeFile(join(path, 'Deleted.java'), 'class Deleted {}\n');
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'base']);
  const repo = await connectRepository(path);
  return { root, path, repo };
}
describe('review before creating a PR', () => {
  it('keeps repositories without a GitHub remote local and never requests their PRs', async () => {
    const f = await fixture();
    const github = new FakeGitHub({} as PullRequest);
    const list = vi.spyOn(github, 'listPRs').mockRejectedValue(new Error('Must not call GitHub'));
    const pull = vi.spyOn(github, 'pull').mockRejectedValue(new Error('Must not call GitHub'));
    const { app, store } = createApp({ dataDir: join(f.root, 'app'), github });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${f.repo.id}/pulls`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { title: 'PR', repositories: [{ repoId: f.repo.id, prNumber: 1 }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('GitHub-remote');
    const local = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'Local',
        repositories: [{ repoId: f.repo.id, prNumber: null, localBase: 'HEAD' }],
      },
    });
    expect(local.statusCode).toBe(200);
    expect(list).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });
  it('changes the local review base without dropping the previous review or starting analysis', async () => {
    const { root, path } = await fixture();
    await git(path, ['checkout', '-b', 'feature']);
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 2; } }\n');
    await git(path, ['add', 'Handler.java']);
    await git(path, ['commit', '-m', 'feature']);
    await writeFile(join(path, 'notes.md'), 'Local notes');
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
    });
    cleanup.push(() => app.close());
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
    const repo = (await post('/api/repositories', { path })).json();
    const session = (
      await post('/api/sessions', {
        title: 'Review',
        repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
      })
    ).json<ReviewSession>();
    expect(session.snapshots[0].files.map((f) => f.path)).toEqual(['notes.md']);
    session.run = {
      id: 'old-review',
      sessionId: session.id,
      version: '1',
      fingerprint: 'old',
      state: 'cancelled',
      startedAt: '',
      events: [],
      result: { ...emptyModelResult(), summary: 'Saved review', contracts: [], indexes: [] },
    };
    store.saveSession(session);
    const response = await post(`/api/sessions/${session.id}/refresh`, {
      localBases: { [repo.id]: 'main' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = response.json<ReviewSession>();
    expect(updated.snapshots[0].local?.baseRef).toBe('main');
    expect(updated.snapshots[0].files.map((f) => f.path)).toContain('Handler.java');
    expect(updated.update?.scopeChanged).toBe(true);
    expect(updated.update?.changes[0].files.map((f) => f.path)).toContain('Handler.java');
    expect(updated.history?.[0].run.result.summary).toBe('Saved review');
    expect(updated.run).toBeNull();
    const same = (await post(`/api/sessions/${session.id}/refresh`, {})).json<ReviewSession>();
    expect(same.snapshots[0].id).toBe(updated.snapshots[0].id);
  });
  it('includes Thrift contracts and ANTLR grammars in local review snapshots', async () => {
    const { root, path, repo } = await fixture();
    await writeFile(join(path, 'api.thrift'), 'struct Customer { 1: string userId }\n');
    await writeFile(join(path, 'Rules.g4'), 'grammar Rules; rule: ID;\n');
    const snapshot = await createLocalSnapshot(repo, 'main', join(root, 'snapshots'));
    expect(snapshot.headFiles).toContain('api.thrift');
    expect(snapshot.headFiles).toContain('Rules.g4');
    expect(snapshot.files.map((f) => f.path)).toContain('api.thrift');
    expect(await readSource(snapshot, { side: 'head', path: 'api.thrift' })).toContain('userId');
    const { app, store } = createApp({
      dataDir: join(root, 'api-data'),
      github: new FakeGitHub({} as PullRequest),
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'Protocols',
        repositories: [{ repoId: repo.id, prNumber: null, localBase: 'main' }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const ready = response.json<ReviewSession>();
    expect(ready.run).toBeNull();
    expect(ready.contracts?.map((c) => c.format)).toEqual(['antlr', 'thrift']);
  });
  it('prefers origin/main and fetches its latest commit before freezing a feature review', async () => {
    const { root, path, repo } = await fixture();
    const remote = join(root, 'remote.git');
    await git(path, ['clone', '--bare', path, remote]);
    await git(path, ['remote', 'add', 'origin', remote]);
    await git(path, ['fetch', 'origin']);
    await git(path, ['checkout', '-b', 'feature']);
    expect(await defaultLocalBase(repo)).toBe('origin/main');
    const publisher = join(root, 'publisher');
    await git(path, ['clone', remote, publisher]);
    await writeFile(join(publisher, 'Published.java'), 'class Published {}\n');
    await git(publisher, ['add', '.']);
    await git(publisher, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-m',
      'new main',
    ]);
    await git(publisher, ['push', 'origin', 'main']);
    const latest = (await git(publisher, ['rev-parse', 'HEAD'])).trim();
    const snapshot = await createLocalSnapshot(repo, 'origin/main', join(root, 'snapshots'));
    expect(snapshot.local?.baseCommit).toBe(latest);
    expect(snapshot.local?.branchName).toBe('feature');
    expect((await git(path, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('feature');
  });
  it('lists local and remote branches to compare with, without the remote HEAD alias', async () => {
    const { root, path, repo } = await fixture();
    const remote = join(root, 'remote.git');
    await git(path, ['clone', '--bare', path, remote]);
    await git(path, ['remote', 'add', 'origin', remote]);
    await git(path, ['fetch', 'origin']);
    await git(path, ['remote', 'set-head', 'origin', 'main']);
    await git(path, ['branch', 'ft/payments']);
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const branches = await app.inject({ url: `/api/repositories/${repo.id}/branches` });
    expect(branches.statusCode).toBe(200);
    const { current, local, remote: remotes } = branches.json<RepositoryBranches>();
    expect(current).toBe('main');
    expect(local.sort()).toEqual(['ft/payments', 'main']);
    expect(remotes).toEqual(['origin/main']);
    expect((await app.inject({ url: '/api/repositories/unknown/branches' })).statusCode).toBe(404);
  });
  it('decodes explicit model questions and approval requests without guessing from prose', () => {
    expect(
      decodeFixResponse(
        JSON.stringify({
          outcome: 'question',
          message: 'Нужно уточнение',
          question: 'Какой формат?',
          options: ['JSON', 'XML'],
        }),
      ).outcome,
    ).toBe('question');
    expect(
      decodeFixResponse(
        JSON.stringify({
          outcome: 'approval',
          message: '',
          question: 'Изменить контракт?',
          options: [],
        }),
      ).outcome,
    ).toBe('approval');
    expect(() => decodeFixResponse('Разрешить действие?')).toThrow();
    expect(() =>
      decodeFixResponse(
        JSON.stringify({ outcome: 'approval', message: '', question: null, options: [] }),
      ),
    ).toThrow();
  });
  it('waits for persisted answers and approvals, rejects duplicate answers, and resumes after partial file changes', async () => {
    const { root, path, repo } = await fixture();
    let turn = 0;
    const calls: Parameters<FixProvider['run']>[0][] = [];
    const fixProvider: FixProvider = {
      run: async (input, _signal, emit) => {
        calls.push(input);
        turn++;
        emit({ type: 'thread.started', thread_id: 'interactive-thread' });
        if (turn === 1)
          emit({
            type: 'fix.request',
            request: {
              kind: 'question',
              prompt: 'Что вернуть для пустого ввода?',
              options: ['Ошибка', 'Пустой результат'],
            },
          });
        else if (turn === 2)
          emit({
            type: 'fix.request',
            request: { kind: 'approval', prompt: 'Одобрить новый контракт?', options: [] },
          });
        else if (turn === 4) {
          await writeFile(
            join(path, 'Handler.java'),
            'class Handler { int run() { return 2; } }\n',
          );
          emit({
            type: 'fix.request',
            request: { kind: 'approval', prompt: 'Добавить проверку совместимости?', options: [] },
          });
        } else {
          if (input.apply)
            await writeFile(
              join(path, 'Handler.java'),
              'class Handler { int run() { return 3; } }\n',
            );
          emit({
            type: 'item.completed',
            item: {
              id: 'answer',
              type: 'agent_message',
              text: input.apply ? 'Готово' : 'План готов',
            },
          });
        }
      },
    };
    const { app, store, fixes } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider,
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'Уточнения',
        repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
      },
    });
    const session = created.json<ReviewSession>();
    const url = `/api/sessions/${session.id}/fix-chat`;
    const request = (action: 'plan' | 'apply') =>
      app.inject({
        method: 'POST',
        url,
        payload: { action, repoId: repo.id, message: 'Проверь пустой ввод' },
      });
    const respond = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `${url}/respond`, payload });
    await request('plan');
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('waiting_input'));
    expect(fixes.isRunning(session.id)).toBe(false);
    expect(turn).toBe(1);
    let chat = store.fixChat(session.id)!;
    const questionId = chat.pending!.id;
    store.recover();
    expect((await app.inject({ method: 'GET', url })).json<FixChat>().pending?.id).toBe(questionId);
    const attention = (await app.inject({ method: 'GET', url: '/api/fix-chat/attention' })).json();
    expect(attention).toEqual([
      {
        sessionId: session.id,
        title: 'Уточнения',
        requestId: questionId,
        kind: 'question',
        prompt: 'Что вернуть для пустого ввода?',
      },
    ]);
    expect((await respond({ requestId: questionId, answer: ' ' })).statusCode).toBe(400);
    expect((await respond({ requestId: questionId, approved: true })).statusCode).toBe(400);
    expect((await request('apply')).statusCode).toBe(409);
    const responses = await Promise.all([
      respond({ requestId: questionId, answer: 'Ошибка' }),
      respond({ requestId: questionId, answer: 'Пустой результат' }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('waiting_approval'));
    chat = store.fixChat(session.id)!;
    expect(chat.events.find((event) => event.request?.id === questionId)?.request?.resolution).toBe(
      'answered',
    );
    expect(calls[1].prompt).toContain('Что вернуть для пустого ввода?');
    expect(calls[1].threadId).toBe('interactive-thread');
    expect((await respond({ requestId: questionId, answer: 'Запоздалый ответ' })).statusCode).toBe(
      409,
    );
    expect((await respond({ requestId: chat.pending!.id, answer: 'Одобряю' })).statusCode).toBe(
      400,
    );
    expect((await respond({ requestId: chat.pending!.id, approved: false })).statusCode).toBe(200);
    expect(store.fixChat(session.id)?.state).toBe('cancelled');
    expect(turn).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/fix-chat/attention' })).json()).toEqual(
      [],
    );
    await request('plan');
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
    await request('apply');
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('waiting_approval'));
    chat = store.fixChat(session.id)!;
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 2');
    expect(turn).toBe(4);
    expect((await respond({ requestId: chat.pending!.id, approved: true })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('complete'));
    await afterFixRefresh(store, session.id);
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 3');
    expect(turn).toBe(5);
    expect(calls[4].apply).toBe(true);
    expect(calls[4].prompt).toContain('explicitly approved the action');
    expect((await app.inject({ method: 'GET', url: '/api/fix-chat/attention' })).json()).toEqual(
      [],
    );
  });
  it('records a rollback point before fixes and reports what Codex changed', async () => {
    const { root, path, repo } = await fixture();
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 10; } }\n');
    await writeFile(join(path, 'Notes.md'), 'user notes\n');
    const fixProvider: FixProvider = {
      run: async (input, _signal, emit) => {
        if (input.apply) {
          await writeFile(
            join(path, 'Handler.java'),
            'class Handler { int run() { return 11; } }\n',
          );
          await writeFile(join(path, 'Added.java'), 'class Added {}\n');
        }
        emit({
          type: 'item.completed',
          item: { id: 'answer', type: 'agent_message', text: input.apply ? 'Готово' : 'План' },
        });
      },
    };
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider,
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          title: 'Local',
          repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
        },
      })
    ).json<ReviewSession>();
    const url = `/api/sessions/${session.id}/fix-chat`;
    for (const [action, state] of [
      ['plan', 'planned'],
      ['apply', 'complete'],
    ]) {
      await app.inject({
        method: 'POST',
        url,
        payload: { repoId: repo.id, action, message: 'Исправить код' },
      });
      await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe(state));
    }
    const chat = store.fixChat(session.id)!;
    const report = chat.events.find((event) => event.id.endsWith(':changes'))!.text;
    expect(report).toContain('Handler.java');
    expect(report).toContain('Added.java');
    expect(report).not.toContain('Notes.md');
    expect(await git(path, ['stash', 'list'])).toBe('');
    await git(path, ['restore', `--source=${chat.rollback!.commit}`, '--worktree', '--', '.']);
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 10');
  });
  it('edits a working file only over the loaded version and never outside the repository', async () => {
    const { root, path, repo } = await fixture();
    await writeFile(join(path, '.gitignore'), 'secret.txt\n');
    await writeFile(join(path, 'secret.txt'), 'token');
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 2; } }\n');
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          title: 'Local',
          repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
        },
      })
    ).json<ReviewSession>();
    const url = `/api/sessions/${session.id}/working-file`;
    const read = (file: string) =>
      app.inject({ method: 'GET', url, query: { repoId: repo.id, path: file } });
    const loaded = (await read('Handler.java')).json<{ content: string; hash: string }>();
    expect(loaded.content).toContain('return 2');
    const save = (hash: string, content: string, file = 'Handler.java') =>
      app.inject({ method: 'PUT', url, payload: { repoId: repo.id, path: file, hash, content } });
    const saved = await save(loaded.hash, 'class Handler { int run() { return 3; } }\n');
    expect(saved.statusCode).toBe(200);
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 3');
    // The old hash no longer matches: the second save would overwrite the first one.
    expect((await save(loaded.hash, 'stale')).statusCode).toBe(409);
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 3');
    expect((await read('secret.txt')).statusCode).toBe(404);
    expect((await read('../outside.txt')).statusCode).toBe(400);
    expect((await save(saved.json().hash, 'x', '../outside.txt')).statusCode).toBe(400);
    const concurrent = await Promise.all([
      save(saved.json().hash, 'class Handler { int run() { return 4; } }\n'),
      save(saved.json().hash, 'class Handler { int run() { return 5; } }\n'),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });
  it('lets Codex continue after the reviewer edited files in the review, but not after outside edits', async () => {
    const { root, path, repo } = await fixture();
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 2; } }\n');
    const prompts: string[] = [];
    const fixProvider: FixProvider = {
      run: async (input, _signal, emit) => {
        prompts.push(input.prompt);
        emit({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'План' } });
      },
    };
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider,
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          title: 'Local',
          repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
        },
      })
    ).json<ReviewSession>();
    const fileUrl = `/api/sessions/${session.id}/working-file`;
    const plan = async (acceptChanges?: boolean) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/fix-chat`,
        payload: { repoId: repo.id, action: 'plan', message: 'Проверь код', acceptChanges },
      });
      if (response.statusCode === 200)
        await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
      return response;
    };
    const edit = async (content: string) => {
      const loaded = (
        await app.inject({
          method: 'GET',
          url: fileUrl,
          query: { repoId: repo.id, path: 'Handler.java' },
        })
      ).json<{ hash: string }>();
      const saved = await app.inject({
        method: 'PUT',
        url: fileUrl,
        payload: { repoId: repo.id, path: 'Handler.java', hash: loaded.hash, content },
      });
      expect(saved.statusCode).toBe(200);
    };
    // Two saves of the same file in the editor, then Codex: no refresh needed.
    await edit('class Handler { int run() { return 3; } }\n');
    await edit('class Handler { int run() { return 4; } }\n');
    expect((await plan()).statusCode).toBe(200);
    expect(prompts[0]).toContain('Handler.java');
    expect(store.fixChat(session.id)!.events.some((e) => e.id.endsWith(':own-edits'))).toBe(true);
    // The accepted folder stays accepted for the next turn, and so do further own edits.
    expect((await plan()).statusCode).toBe(200);
    await edit('class Handler { int run() { return 5; } }\n');
    expect((await plan()).statusCode).toBe(200);
    // A change made outside the review asks first, and is kept once the reviewer owns it.
    await writeFile(join(path, 'Other.java'), 'class Other {}\n');
    const refused = await plan();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'working-folder-changed' });
    expect((await plan(true)).statusCode).toBe(200);
    expect(prompts.at(-1)).toContain('do not revert it');
    expect(store.fixChat(session.id)!.events.some((e) => e.id.endsWith(':own-edits'))).toBe(true);
    expect((await plan()).statusCode).toBe(200);
  });
  it('fixes Codex comments one step per turn, keeps the first rollback point and runs the rest in a row', async () => {
    const { root, path, repo } = await fixture();
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 10; } }\n');
    const calls: Parameters<FixProvider['run']>[0][] = [];
    const fixProvider: FixProvider = {
      run: async (input, _signal, emit) => {
        calls.push(input);
        if (input.apply)
          await writeFile(
            join(path, 'Handler.java'),
            `class Handler { int run() { return ${10 + calls.length}; } }\n`,
          );
        emit({
          type: 'item.completed',
          item: { id: 'answer', type: 'agent_message', text: `Шаг ${calls.length} готов` },
        });
      },
    };
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider,
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          title: 'Local',
          repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
        },
      })
    ).json<ReviewSession>();
    const snapshot = session.snapshots[0];
    const evidence = {
      repoId: repo.id,
      side: 'head' as const,
      path: 'Handler.java',
      startLine: 1,
      endLine: 1,
    };
    store.saveDraft({
      sessionId: session.id,
      snapshotId: snapshot.id,
      headSha: snapshot.headSha,
      body: '',
      action: 'COMMENT',
      state: 'draft',
      attempt: null,
      submission: null,
      comments: [
        { id: 'a', body: 'Верни 20', evidence, selected: false, forCodex: true },
        { id: 'note', body: 'Для людей', evidence, selected: true },
        { id: 'b', body: 'Добавь лог', evidence, selected: false, forCodex: true },
        { id: 'c', body: 'Переименуй метод', evidence, selected: false, forCodex: true },
      ],
    });
    const url = `/api/sessions/${session.id}/fix-chat`;
    const step = (payload: object) =>
      app.inject({ method: 'POST', url, payload: { repoId: repo.id, action: 'step', ...payload } });
    expect((await step({})).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('stepped'));
    expect(calls[0].prompt).toContain('Верни 20');
    expect(calls[0].prompt).not.toContain('Для людей');
    expect(calls[0].apply).toBe(true);
    const rollback = store.fixChat(session.id)!.rollback!.commit;
    expect((await step({ all: true })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('complete'));
    await afterFixRefresh(store, session.id);
    const chat = store.fixChat(session.id)!;
    expect(chat.steps?.map((item) => [item.commentId, item.state])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
      ['c', 'done'],
    ]);
    expect(
      calls.map((call) => call.prompt.match(/and leave all other comments alone:\n.*\n(.*)/)?.[1]),
    ).toEqual(['Верни 20', 'Добавь лог', 'Переименуй метод']);
    expect(calls[2].prompt).not.toContain('Верни 20');
    expect(chat.rollback!.commit).toBe(rollback);
    expect((await step({})).statusCode).toBe(409);
    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/refresh`,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const updated = refreshed.json<ReviewSession>();
    expect(updated.snapshots[0].id).not.toBe(snapshot.id);
    expect(store.fixChat(session.id)?.completedSteps).toHaveLength(3);
    expect((await step({})).statusCode).toBe(409);
    expect((await step({ stepId: 'a' })).statusCode).toBe(409);
    expect(calls).toHaveLength(3);
    const draft = store.draft(session.id, updated.snapshots[0].id)!;
    expect(draft.comments.find((comment) => comment.id === 'a')?.body).toBe('Верни 20');
    store.saveDraft({
      ...draft,
      comments: [
        ...draft.comments,
        {
          id: 'new-task',
          body: 'Новое исправление',
          forCodex: true,
          selected: false,
          evidence: null,
        },
      ],
    });
    expect((await step({ all: true })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('complete'));
    expect(calls).toHaveLength(4);
    expect(calls[3].prompt).toContain('Новое исправление');
    expect(calls[3].prompt).not.toContain('Верни 20');
    expect(store.fixChat(session.id)?.completedSteps).toHaveLength(4);
  });
  it('lets the reviewer skip plan steps, also during a run in a row, and return them to the plan', async () => {
    const { root, repo } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const fixProvider: FixProvider = {
      run: async (input, _signal, emit) => {
        const task = input.prompt.match(/and leave all other comments alone:\n.*\n(.*)/)![1];
        calls.push(task);
        if (task === 'Шаг A') await gate;
        if (task === 'Шаг E')
          return emit({
            type: 'fix.request',
            request: { kind: 'question', prompt: 'Как назвать?', options: [] },
          });
        emit({
          type: 'item.completed',
          item: { id: 'answer', type: 'agent_message', text: `${task} готов` },
        });
      },
    };
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider,
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          title: 'Local',
          repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
        },
      })
    ).json<ReviewSession>();
    const snapshot = session.snapshots[0];
    const task = (id: string) => ({
      id,
      body: `Шаг ${id.toUpperCase()}`,
      evidence: null,
      selected: false,
      forCodex: true,
    });
    const draft = {
      sessionId: session.id,
      snapshotId: snapshot.id,
      headSha: snapshot.headSha,
      body: '',
      action: 'COMMENT' as const,
      state: 'draft' as const,
      attempt: null,
      submission: null,
      comments: ['a', 'b', 'c', 'd'].map(task),
    };
    store.saveDraft(draft);
    const url = `/api/sessions/${session.id}/fix-chat`;
    const skip = (commentId: string, skipped = true) =>
      app.inject({
        method: 'POST',
        url: `${url}/skip`,
        payload: { repoId: repo.id, commentId, skipped },
      });
    const skippedIds = () =>
      store
        .fixChat(session.id)
        ?.completedSteps?.filter((step) => step.skipped)
        .map((step) => step.commentId)
        .sort();
    expect((await skip('b')).statusCode).toBe(200);
    expect(skippedIds()).toEqual(['b']);
    expect((await skip('b', false)).statusCode).toBe(200);
    expect(skippedIds()).toEqual([]);
    expect((await skip('b')).statusCode).toBe(200);
    expect((await skip('missing')).statusCode).toBe(404);

    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { repoId: repo.id, action: 'step', all: true },
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(() => expect(calls).toEqual(['Шаг A']));
    // The step in progress is stopped, not skipped; the others can be skipped meanwhile.
    expect((await skip('a')).statusCode).toBe(409);
    expect((await skip('c')).statusCode).toBe(200);
    expect((await skip('c', false)).statusCode).toBe(409);
    release();
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('complete'));
    expect(calls).toEqual(['Шаг A', 'Шаг D']);
    expect(skippedIds()).toEqual(['b', 'c']);
    expect(
      store
        .fixChat(session.id)
        ?.completedSteps?.filter((step) => !step.skipped)
        .map((step) => step.commentId)
        .sort(),
    ).toEqual(['a', 'd']);
    expect((await skip('a')).statusCode).toBe(409);

    // The completed batch refreshes on the server before another task can start.
    await afterFixRefresh(store, session.id);
    const currentDraft = store
      .drafts(session.id)
      .find((d) => d.snapshotId === store.session(session.id)!.snapshots[0].id)!;
    // Declining a step that waits for an answer closes its question.
    store.saveDraft({ ...currentDraft, comments: [...currentDraft.comments, task('e')] });
    await app.inject({ method: 'POST', url, payload: { repoId: repo.id, action: 'step' } });
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('waiting_input'));
    expect((await skip('e')).statusCode).toBe(200);
    const chat = store.fixChat(session.id)!;
    expect(chat.pending).toBeUndefined();
    expect(chat.state).toBe('complete');
    expect(chat.events.find((event) => event.request)?.request?.resolution).toBe('cancelled');
    expect(skippedIds()).toEqual(['b', 'c', 'e']);
    expect((await app.inject({ method: 'GET', url: '/api/fix-chat/attention' })).json()).toEqual(
      [],
    );
  });
  it('does not resume a waiting action after external code edits and supports cancelling the question', async () => {
    const { root, path, repo } = await fixture();
    const run = vi.fn<FixProvider['run']>(async (_input, _signal, emit) => {
      emit({
        type: 'fix.request',
        request: { kind: 'question', prompt: 'Как продолжить?', options: [] },
      });
    });
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider: { run },
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'Local',
        repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
      },
    });
    const session = created.json<ReviewSession>(),
      url = `/api/sessions/${session.id}/fix-chat`;
    await app.inject({
      method: 'POST',
      url,
      payload: { repoId: repo.id, action: 'plan', message: 'Исправить код' },
    });
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('waiting_input'));
    const id = store.fixChat(session.id)!.pending!.id;
    await writeFile(join(path, 'Handler.java'), 'external edit');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/respond`,
          payload: { requestId: id, answer: 'Продолжить' },
        })
      ).statusCode,
    ).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.fixChat(session.id)?.pending?.id).toBe(id);
    await app.inject({ method: 'POST', url: `${url}/cancel`, payload: {} });
    expect(store.fixChat(session.id)?.pending).toBeUndefined();
    expect(
      store.fixChat(session.id)?.events.find((event) => event.request?.id === id)?.request
        ?.resolution,
    ).toBe('cancelled');
  });
  it('pins branch commits, staged/unstaged/new/deleted files without changing the branch or index', async () => {
    const { root, path, repo } = await fixture();
    expect(repo.slug).toMatch(/^local\//);
    await git(path, ['switch', '-c', 'feature']);
    await writeFile(join(path, 'Committed.java'), 'class Committed {}\n');
    await git(path, ['add', '.']);
    await git(path, ['commit', '-m', 'feature']);
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 2; } }\n');
    await git(path, ['add', 'Handler.java']);
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 3; } }\n');
    await writeFile(join(path, 'New.java'), 'class New {}\n');
    await rm(join(path, 'Deleted.java'));
    await writeFile(join(path, '.env'), 'TOKEN=secret');
    await mkdir(join(path, '.codex'));
    await writeFile(join(path, '.codex', 'auth.json'), '{"token":"secret"}');
    await symlink(join(path, 'Handler.java'), join(path, 'Link.java'));
    const staged = await git(path, ['diff', '--cached']);
    const head = await git(path, ['rev-parse', 'HEAD']);
    const snapshot = await createLocalSnapshot(repo, 'main', join(root, 'snapshots'));
    expect(snapshot.pr).toBeNull();
    expect(snapshot.local?.baseRef).toBe('main');
    expect(snapshot.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['Committed.java', 'Handler.java', 'New.java', 'Deleted.java']),
    );
    expect(snapshot.headFiles).not.toContain('.env');
    expect(snapshot.headFiles).not.toContain('.codex/auth.json');
    expect(snapshot.headFiles).not.toContain('Link.java');
    expect(await readSource(snapshot, { side: 'head', path: 'Handler.java' })).toContain(
      'return 3',
    );
    expect(await readSource(snapshot, { side: 'base', path: 'Handler.java' })).toContain(
      'return 1',
    );
    expect(await git(path, ['diff', '--cached'])).toBe(staged);
    expect(await git(path, ['rev-parse', 'HEAD'])).toBe(head);
    await writeFile(join(path, 'Handler.java'), 'later edit');
    expect(await readSource(snapshot, { side: 'head', path: 'Handler.java' })).toContain(
      'return 3',
    );
    expect((await workingSources(repo)).fingerprint).not.toBe(snapshot.local?.fingerprint);
  });
  it('saves comments, streams and persists the plan/execution, rejects stale plans and refreshes code without a PR', async () => {
    const { root, path } = await fixture();
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 2; } }\n');
    const calls: Parameters<FixProvider['run']>[0][] = [];
    const fixProvider: FixProvider = {
      run: async (input, _signal, emit) => {
        calls.push(input);
        emit({ type: 'thread.started', thread_id: 'local-thread' });
        emit({
          type: 'item.completed',
          item: {
            id: 'plan',
            type: 'todo_list',
            items: [{ text: 'Исправить run', completed: input.apply }],
          },
        });
        if (input.apply) {
          await writeFile(
            join(input.repo.path, 'Handler.java'),
            'class Handler { int run() { return 4; } }\n',
          );
          emit({
            type: 'item.completed',
            item: {
              id: 'files',
              type: 'file_change',
              status: 'completed',
              changes: [{ path: 'Handler.java', kind: 'update' }],
            },
          });
        }
        emit({
          type: 'item.completed',
          item: {
            id: 'message',
            type: 'agent_message',
            text: input.apply ? 'Исправлено' : 'План: исправить run',
          },
        });
        emit({
          type: 'turn.completed',
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        });
      },
    };
    const github = new FakeGitHub({} as PullRequest);
    const pull = vi.spyOn(github, 'pull');
    const { app, store, fixes } = createApp({ dataDir: join(root, 'data'), github, fixProvider });
    cleanup.push(() => app.close());
    const request = async (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, payload });
    const repoResponse = await request('/api/repositories', { path });
    const repo = repoResponse.json();
    const created = await request('/api/sessions', {
      title: 'До PR',
      repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
    });
    expect(created.statusCode, created.body).toBe(200);
    const session = created.json<ReviewSession>(),
      snap = session.snapshots[0];
    const draft = (
      await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/drafts` })
    ).json<ReviewDraft[]>()[0];
    draft.comments.push({
      id: 'question',
      body: 'Верни 4 вместо 2',
      selected: true,
      evidence: { repoId: repo.id, path: 'Handler.java', side: 'head', startLine: 1, endLine: 1 },
    });
    const save = () =>
      app.inject({
        method: 'PUT',
        url: `/api/sessions/${session.id}/drafts/${snap.id}`,
        payload: draft,
      });
    expect((await save()).statusCode).toBe(200);
    const url = `/api/sessions/${session.id}/fix-chat`;
    expect((await request(url, { action: 'apply', repoId: repo.id })).statusCode).toBe(409);
    expect((await request(url, { action: 'plan', repoId: repo.id })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 2');
    expect(calls[0].prompt).toContain('Верни 4 вместо 2');
    draft.comments[0].body += ' пожалуйста';
    await save();
    expect((await request(url, { action: 'apply', repoId: repo.id })).statusCode).toBe(409);
    await request(url, { action: 'plan', repoId: repo.id, message: 'Уточни план' });
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
    expect((await request(url, { action: 'apply', repoId: repo.id })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('complete'));
    await afterFixRefresh(store, session.id);
    expect(fixes.isRunning(session.id)).toBe(false);
    expect(calls.at(-1)?.apply).toBe(true);
    expect(calls.at(-1)?.threadId).toBe('local-thread');
    expect(
      (await app.inject({ method: 'GET', url }))
        .json()
        .events.some((event: { kind: string }) => event.kind === 'files'),
    ).toBe(true);
    expect(await readFile(join(path, 'Handler.java'), 'utf8')).toContain('return 4');
    const refresh = await request(`/api/sessions/${session.id}/refresh`, {});
    expect(refresh.statusCode, refresh.body).toBe(200);
    const updated = refresh.json<ReviewSession>();
    expect(updated.snapshots[0].headSha).not.toBe(snap.headSha);
    expect(
      await readSource(updated.snapshots[0], { path: 'Handler.java', side: 'head' }),
    ).toContain('return 4');
    const unchanged = (
      await request(`/api/sessions/${session.id}/refresh`, {})
    ).json<ReviewSession>();
    expect(unchanged.snapshots[0].id).toBe(updated.snapshots[0].id);
    expect(pull).not.toHaveBeenCalled();
    expect(
      (await request(`/api/sessions/${session.id}/drafts/${updated.snapshots[0].id}/submit`, {}))
        .statusCode,
    ).toBe(400);
  });
  it('supports cancellation, blocks concurrent refresh/delete and detects external edits before applying', async () => {
    const { root, path, repo } = await fixture();
    let hanging = false;
    const fixProvider: FixProvider = {
      run: async (_input, signal, emit) => {
        if (hanging)
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        else
          emit({
            type: 'item.completed',
            item: { id: 'plan', type: 'agent_message', text: 'План' },
          });
      },
    };
    const { app, store } = createApp({
      dataDir: join(root, 'data'),
      github: new FakeGitHub({} as PullRequest),
      fixProvider,
    });
    cleanup.push(() => app.close());
    store.saveRepository(repo);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'Local',
        repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
      },
    });
    const session = created.json<ReviewSession>();
    const url = `/api/sessions/${session.id}/fix-chat`;
    const plan = () =>
      app.inject({
        method: 'POST',
        url,
        payload: { action: 'plan', repoId: repo.id, message: 'Проверь метод' },
      });
    await plan();
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('planned'));
    await writeFile(join(path, 'Handler.java'), 'external change');
    expect(
      (await app.inject({ method: 'POST', url, payload: { action: 'apply', repoId: repo.id } }))
        .statusCode,
    ).toBe(409);
    await writeFile(join(path, 'Handler.java'), 'class Handler { int run() { return 1; } }\n');
    hanging = true;
    await plan();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${session.id}/refresh`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, payload: {} }))
        .statusCode,
    ).toBe(409);
    expect((await plan()).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `${url}/cancel`, payload: {} });
    await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('cancelled'));
  });
});

describe('selected Codex packets', () => {
  for (const [together, question] of [
    [true, false],
    [false, false],
    [true, true],
  ] as const)
    it(`runs only selected comments ${together ? 'together' : 'in order'}${question ? ' after a saved question' : ''}`, async () => {
      const f = await fixture();
      const calls: Parameters<FixProvider['run']>[0][] = [];
      const { app, store, fixes } = createApp({
        dataDir: join(f.root, 'packet-app'),
        fixProvider: {
          run: async (input, _signal, emit) => {
            calls.push(input);
            emit({ type: 'thread.started', thread_id: 'packet-thread' });
            if (question && calls.length === 1) {
              emit({
                type: 'fix.request',
                request: { kind: 'question', prompt: 'Which behavior?', options: [] },
              });
              return;
            }
            emit({
              type: 'item.completed',
              item: {
                id: `done-${calls.length}`,
                type: 'agent_message',
                text: 'Fixed selected packet',
              },
            });
          },
        },
      });
      cleanup.push(() => app.close());
      store.saveRepository(f.repo);
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          title: 'Packet',
          repositories: [{ repoId: f.repo.id, prNumber: null, localBase: 'HEAD' }],
        },
      });
      const session = created.json<ReviewSession>();
      const draft = (
        await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/drafts` })
      ).json<ReviewDraft[]>()[0];
      store.saveDraft({
        ...draft,
        comments: ['first', 'second', 'unselected'].map((id) => ({
          id,
          body: `Task ${id}`,
          evidence: null,
          selected: false,
          forCodex: true,
        })),
      });
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/fix-chat`,
        payload: {
          repoId: f.repo.id,
          action: 'step',
          commentIds: ['second', 'first'],
          together,
          all: !together,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      if (question) {
        await vi.waitFor(() => expect(store.fixChat(session.id)?.state).toBe('waiting_input'));
        await vi.waitFor(() => expect(fixes.isRunning(session.id)).toBe(false));
        store.recover();
        const chat = store.fixChat(session.id)!;
        expect(chat.selection).toEqual({ commentIds: ['second', 'first'], together: true });
        const answer = await app.inject({
          method: 'POST',
          url: `/api/sessions/${session.id}/fix-chat/respond`,
          payload: { requestId: chat.pending!.id, answer: 'Keep the existing behavior' },
        });
        expect(answer.statusCode, answer.body).toBe(200);
      }
      await vi.waitFor(() => {
        expect(store.fixChat(session.id)?.state).toBe('complete');
        expect(fixes.isRunning(session.id)).toBe(false);
        expect(calls).toHaveLength((together ? 1 : 2) + Number(question));
      });
      expect(
        store
          .fixChat(session.id)
          ?.completedSteps?.map((s) => s.commentId)
          .sort(),
      ).toEqual(['first', 'second']);
      expect(calls[0].prompt).not.toContain('Task unselected');
      if (!together) expect(calls[0].prompt).toContain('Task second');
      expect(store.fixChat(session.id)?.state).toBe('complete');
      if (together) {
        expect(calls[0].prompt).toContain('Task first');
        expect(calls[0].prompt).toContain('Task second');
      }
    });
});
