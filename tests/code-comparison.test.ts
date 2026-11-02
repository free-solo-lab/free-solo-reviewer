import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import {
  emptyModelResult,
  type ReviewSession,
  type Snapshot,
  type Evidence,
} from '../shared/model';
import type { CodeComparison } from '../shared/code-comparison';
import { sourceMethodRows } from '../shared/source-methods';
import { reviewDiffRows } from '../shared/source-diff';
import { SourceCode } from '../web/components';
import { fixture } from './fixtures';
import { git } from '../server/process';
import { createSnapshot } from '../server/repository';
import { codeComparison } from '../server/code-comparison';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const evidence: Evidence = {
  repoId: 'repo',
  path: 'Service.java',
  side: 'head',
  startLine: 1,
  endLine: 1,
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'review-compare-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const snapshot = async (id: string, files: Record<string, string>): Promise<Snapshot> => {
    const headDir = join(root, id, 'head'),
      baseDir = join(root, id, 'base');
    await mkdir(headDir, { recursive: true });
    await mkdir(baseDir, { recursive: true });
    for (const [path, text] of Object.entries(files)) await writeFile(join(headDir, path), text);
    await writeFile(join(baseDir, 'Service.java'), 'merge base is different\n');
    return {
      id,
      repoId: 'repo',
      repoName: 'Service',
      slug: 'org/service',
      pr: { number: 1 },
      headSha: id,
      baseSha: 'base',
      mergeBase: 'base',
      headDir,
      baseDir,
      headFiles: Object.keys(files),
      baseFiles: ['Service.java'],
      files: [],
    } as unknown as Snapshot;
  };
  const old = await snapshot('reviewed-head', {
    'Service.java': 'reviewed old\n',
    'Renamed.java': 'old name\n',
    'Deleted.java': 'gone\n',
    'Same.java': 'same\n',
  });
  const current = await snapshot('new-head', {
    'Service.java': 'fixed\n',
    'NewName.java': 'old name\n',
    'Added.java': 'new file\n',
    'Same.java': 'same\n',
  });
  const run = {
    id: 'past-review',
    sessionId: 'session',
    fingerprint: 'old',
    version: '1',
    state: 'complete' as const,
    startedAt: '',
    events: [],
    result: { ...emptyModelResult(), indexes: [], contracts: [] },
  };
  const session: ReviewSession = {
    id: 'session',
    title: '',
    createdAt: '',
    snapshots: [current],
    run: { ...run, id: 'new-review' },
    history: [{ id: run.id, savedAt: '', snapshots: [old], run, drafts: [] }],
    update: {
      id: 'update',
      at: '',
      previousReviewId: run.id,
      gaps: [],
      discussion: [],
      changes: [
        {
          repoId: 'repo',
          fromSha: old.headSha,
          toSha: current.headSha,
          files: [
            {
              path: 'Service.java',
              status: 'M',
              addedLines: [1],
              removedLines: [1],
              patch: '@@ -1 +1 @@\n-reviewed old\n+fixed\n',
            },
            {
              path: 'NewName.java',
              oldPath: 'Renamed.java',
              status: 'R100',
              addedLines: [],
              removedLines: [],
              patch: '',
            },
            {
              path: 'Added.java',
              status: 'A',
              addedLines: [1],
              removedLines: [],
              patch: '@@ -0,0 +1 @@\n+new file\n',
            },
            {
              path: 'Deleted.java',
              status: 'D',
              addedLines: [],
              removedLines: [1],
              patch: '@@ -1 +0,0 @@\n-gone\n',
            },
          ],
        },
      ],
    },
  };
  const { app, store } = createApp({ dataDir: join(root, 'data') });
  cleanup.push(() => app.close());
  store.saveSession(session);
  const request = (path: string, revisionId = 'past-review', repoId = 'repo') =>
    app.inject({
      method: 'GET',
      url: `/api/sessions/session/code-comparison?${new URLSearchParams({ path, revisionId, repoId })}`,
      headers: { host: '127.0.0.1:4318' },
    });
  return { request, store, session };
}
describe('code comparison with a previous review', () => {
  it('does not hide a deleted method when the following unchanged method was already viewed', () => {
    const text = 'class Service {\n  void keep() {}\n}';
    const file = {
      path: evidence.path,
      status: 'M',
      addedLines: [],
      removedLines: [2],
      patch: '@@ -1,4 +1,3 @@\n class Service {\n-  void removed() {}\n   void keep() {}\n }',
    };
    const rows = reviewDiffRows(text, evidence, file, evidence.path);
    const method = {
      key: 'keep',
      viewed: true,
      method: {
        name: 'keep',
        signature: 'void keep()',
        calls: [],
        annotations: [],
        evidence: { ...evidence, startLine: 2, endLine: 2 },
      },
    };
    expect(
      sourceMethodRows(rows, [method]).find((entry) => entry.row.historical)?.method,
    ).toBeUndefined();
  });

  it('compares the pinned previous head instead of merge-base, retaining the stored analysis', async () => {
    const f = await setup();
    const response = await f.request('Service.java');
    expect(response.statusCode).toBe(200);
    const result = response.json<CodeComparison>();
    expect(result.previousSha).toBe('reviewed-head');
    expect(result.currentSha).toBe('new-head');
    expect(result.text).toBe('fixed\n');
    expect(result.file.patch).toContain('-reviewed old');
    expect(result.file.patch).not.toContain('merge base');
    const rows = reviewDiffRows(result.text, evidence, result.file, result.previousPath);
    expect(rows.find((row) => row.kind === 'deletion')).toMatchObject({
      historical: true,
      evidence: { side: 'head', startLine: 1 },
    });
    const html = renderToStaticMarkup(
      React.createElement(SourceCode, {
        text: result.text,
        evidence,
        comparison: result,
        onSelect() {},
        onHistoricalSource() {},
      }),
    );
    expect(html).toContain('data-source-side="previous"');
    expect(html).toContain('reviewed old');
    expect(html).toContain('fixed');
    expect(f.store.session('session')).toEqual(f.session);
    for (const [path, revision, repo] of [
      ['../secret', 'past-review', 'repo'],
      ['Service.java', 'missing', 'repo'],
      ['Service.java', 'past-review', 'other'],
    ])
      expect((await f.request(path, revision, repo)).statusCode).toBe(404);
  });
  it('handles renames, additions, deletions and unchanged files without inventing differences', async () => {
    const f = await setup();
    const renamed = (await f.request('Renamed.java')).json<CodeComparison>();
    expect(renamed.path).toBe('NewName.java');
    expect(renamed.previousPath).toBe('Renamed.java');
    const added = (await f.request('Added.java')).json<CodeComparison>();
    expect(
      reviewDiffRows(
        added.text,
        { ...evidence, path: added.path },
        added.file,
        added.previousPath,
      ).every((row) => row.kind === 'addition' && !row.historical),
    ).toBe(true);
    const deleted = (await f.request('Deleted.java')).json<CodeComparison>();
    expect(deleted.text).toBe('');
    expect(
      reviewDiffRows(
        deleted.text,
        { ...evidence, path: deleted.path },
        deleted.file,
        deleted.previousPath,
      ),
    ).toMatchObject([{ kind: 'deletion', historical: true, text: 'gone' }]);
    const same = (await f.request('Same.java')).json<CodeComparison>();
    expect(same.file.status).toBe('unchanged');
    expect(same.file.patch).toBe('');
  });
  it('can calculate a diff between older review heads when no saved update patch exists', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const { app, store } = createApp({ dataDir: join(f.root, 'comparison') });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const old = await createSnapshot(f.repo, 12, join(f.root, 'pinned'), f.github);
    const path = 'review-extra.txt';
    await writeFile(join(f.repo.path, path), 'after my review\n');
    await git(f.repo.path, ['add', path]);
    await git(f.repo.path, ['commit', '-m', 'Changes after review']);
    const sha = (await git(f.repo.path, ['rev-parse', 'HEAD'])).trim();
    await git(f.repo.path, ['push', '--force', 'origin', `${sha}:refs/pull/12/head`]);
    f.github.pr = { ...f.github.pr, headRefOid: sha };
    const current = await createSnapshot(f.repo, 12, join(f.root, 'pinned'), f.github);
    const run = {
      id: 'past',
      sessionId: 'session',
      version: '1',
      fingerprint: 'past',
      startedAt: '',
      events: [],
      state: 'complete' as const,
      result: { ...emptyModelResult(), indexes: [], contracts: [] },
    };
    const session: ReviewSession = {
      id: 'session',
      title: '',
      createdAt: '',
      snapshots: [current],
      run: null,
      history: [{ id: 'past', savedAt: '', snapshots: [old], run, drafts: [] }],
    };
    const result = await codeComparison(store, session, 'past', f.repo.id, path);
    expect(result.file.patch).toContain('+after my review');
    expect(result.previousSha).toBe(old.headSha);
    expect(result.currentSha).toBe(sha);
  });
});
