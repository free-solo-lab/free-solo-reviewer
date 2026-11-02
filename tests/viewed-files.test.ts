import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { fileExtension, reviewFilePath, type FileViewStatus } from '../shared/viewed-files';
import type { MethodView } from '../shared/viewed-methods';
import type { Snapshot, ReviewSession, PullRequest } from '../shared/model';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'review-viewed-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const snapshot = async (id: string, text: string): Promise<Snapshot> => {
    const headDir = join(root, id, 'head'),
      baseDir = join(root, id, 'base');
    await mkdir(headDir, { recursive: true });
    await mkdir(baseDir, { recursive: true });
    await writeFile(join(headDir, 'Service.java'), text);
    await writeFile(join(baseDir, 'Service.java'), 'original');
    return {
      id,
      repoId: 'repo',
      repoName: 'Service',
      slug: 'org/service',
      pr: { number: 42 } as PullRequest,
      headSha: id,
      baseSha: 'base',
      mergeBase: 'base',
      headDir,
      baseDir,
      headFiles: ['Service.java'],
      baseFiles: ['Service.java'],
      files: [{ path: 'Service.java', status: 'M', patch: '', addedLines: [1], removedLines: [1] }],
    };
  };
  const options = {
    dataDir: join(root, 'data'),
    provider: {
      id: 'unused',
      async analyze() {
        throw new Error('must not analyze');
      },
    },
  };
  let current = createApp(options);
  cleanup.push(() => current.app.close());
  const request = async (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    current.app.inject({
      method,
      url,
      headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });
  const save = (snap: Snapshot, id = 'session') => {
    const session: ReviewSession = {
      id,
      title: 'Review',
      createdAt: '',
      run: null,
      snapshots: [snap],
    };
    current.store.saveSession(session);
  };
  return {
    snapshot,
    save,
    request,
    get store() {
      return current.store;
    },
    async reopen() {
      await current.app.close();
      current = createApp(options);
    },
  };
}
describe('viewed files', () => {
  it('persists across restart and PR refresh, resetting changed contents and isolating PRs', async () => {
    const f = await setup(),
      first = await f.snapshot('first', 'reviewed contents');
    f.save(first);
    const mark = await f.request('PUT', '/api/sessions/session/viewed-files', {
      snapshotId: first.id,
      path: 'Service.java',
      viewed: true,
    });
    expect(mark.statusCode).toBe(200);
    await f.reopen();
    expect(
      (await f.request('GET', '/api/sessions/session/viewed-files')).json<FileViewStatus[]>(),
    ).toEqual([{ snapshotId: 'first', path: 'Service.java', viewed: true }]);
    const same = await f.snapshot('new-commit', 'reviewed contents');
    f.save(same);
    expect(
      (await f.request('GET', '/api/sessions/session/viewed-files')).json<FileViewStatus[]>()[0]
        .snapshotId,
    ).toBe('new-commit');
    f.save({ ...same, id: 'another-pr', pr: { number: 43 } as PullRequest }, 'other');
    expect((await f.request('GET', '/api/sessions/other/viewed-files')).json()).toEqual([]);
    const changed = await f.snapshot('changed', 'changed contents');
    f.save(changed);
    expect((await f.request('GET', '/api/sessions/session/viewed-files')).json()).toEqual([]);
    await f.request('PUT', '/api/sessions/session/viewed-files', {
      snapshotId: changed.id,
      path: 'Service.java',
      viewed: true,
    });
    await f.request('PUT', '/api/sessions/session/viewed-files', {
      snapshotId: changed.id,
      path: 'Service.java',
      viewed: false,
    });
    expect((await f.request('GET', '/api/sessions/session/viewed-files')).json()).toEqual([]);
    expect(f.store.session('session')?.run).toBeNull();
    expect(
      (
        await f.request('PUT', '/api/sessions/session/viewed-files', {
          snapshotId: changed.id,
          path: '../secret',
          viewed: true,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.request('GET', '/api/sessions/session/viewed-files?snapshotIds=unknown')).statusCode,
    ).toBe(404);
  });
  it('does not carry a deleted-file mark to a recreated file and cleans marks with the last review', async () => {
    const f = await setup(),
      snapshot = await f.snapshot('deleted', 'unused');
    snapshot.headFiles = [];
    snapshot.files[0].status = 'D';
    f.save(snapshot);
    await f.request('PUT', '/api/sessions/session/viewed-files', {
      snapshotId: snapshot.id,
      path: 'Service.java',
      viewed: true,
    });
    expect((await f.request('GET', '/api/sessions/session/viewed-files')).json()).toHaveLength(1);
    f.save(snapshot, 'same-pr');
    f.store.deleteSession('same-pr');
    expect(f.store.viewedFiles()).toHaveLength(1);
    const recreated = await f.snapshot('recreated', 'original');
    f.save(recreated);
    expect((await f.request('GET', '/api/sessions/session/viewed-files')).json()).toEqual([]);
    f.store.deleteSession('session');
    expect(f.store.viewedFiles()).toEqual([]);
  });
  it('persists viewed methods, retaining unchanged methods across unrelated edits', async () => {
    const f = await setup();
    const code = `class Service {
  String first() {
    return "first";
  }
  String second() {
    return "second";
  }
}`;
    const first = await f.snapshot('method-first', code);
    f.save(first);
    const url = '/api/sessions/session/viewed-methods';
    const list = async (snapshot: Snapshot) =>
      (await f.request('GET', `${url}?snapshotId=${snapshot.id}&path=Service.java&side=head`)).json<
        MethodView[]
      >();
    const methods = await list(first);
    expect(methods.map((entry) => entry.method.name)).toEqual(['first', 'second']);
    const mark = await f.request('PUT', url, {
      snapshotId: first.id,
      path: 'Service.java',
      side: 'head',
      line: methods[0].method.evidence.startLine,
      viewed: true,
    });
    expect(mark.statusCode).toBe(200);
    await f.reopen();
    expect((await list(first)).map((entry) => entry.viewed)).toEqual([true, false]);
    const shifted = await f.snapshot('method-shift', '\n' + code.replace('"second"', '"changed"'));
    f.save(shifted);
    expect((await list(shifted)).map((entry) => entry.viewed)).toEqual([true, false]);
    const changed = await f.snapshot('method-changed', code.replace('"first"', '"new first"'));
    f.save(changed);
    expect((await list(changed)).map((entry) => entry.viewed)).toEqual([false, false]);
    const unknown = await f.request('PUT', url, {
      snapshotId: changed.id,
      path: 'Service.java',
      side: 'head',
      line: 999,
      viewed: true,
    });
    expect(unknown.statusCode).toBe(404);
    f.save(first);
    await f.request('PUT', url, {
      snapshotId: first.id,
      path: 'Service.java',
      side: 'head',
      line: methods[0].method.evidence.startLine,
      viewed: false,
    });
    expect((await list(first)).every((entry) => !entry.viewed)).toBe(true);
    await f.request('PUT', url, {
      snapshotId: first.id,
      path: 'Service.java',
      side: 'head',
      line: methods[0].method.evidence.startLine,
      viewed: true,
    });
    f.store.deleteSession('session');
    expect(f.store.viewedMethods()).toEqual([]);
  });
  it('normalizes extensions and maps the old side of renames to the file in the tree', () => {
    expect(
      ['Service.JAVA', 'schema.sql', 'Dockerfile', '.gitignore', 'protocol.thrift'].map(
        fileExtension,
      ),
    ).toEqual(['.java', '.sql', '', '', '.thrift']);
    const snapshot = {
      headFiles: ['new/Service.java'],
      files: [{ path: 'new/Service.java', oldPath: 'old/Service.java' }],
    } as Snapshot;
    expect(reviewFilePath(snapshot, 'old/Service.java')).toBe('new/Service.java');
  });
});
