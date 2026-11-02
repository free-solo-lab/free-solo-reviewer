import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cacheDrafts, clearDraftCache, DraftSaveQueue, restoreDrafts } from '../web/draft-cache';
import { commentsAtLine } from '../shared/review-comments';
import { Diff, SourceCode } from '../web/components';
import type { ChangedFile, Evidence, ReviewDraft } from '../shared/model';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
const ref: Evidence = {
  repoId: 'repo',
  side: 'head',
  path: 'Service.kt',
  startLine: 1,
  endLine: 2,
};
const draft: ReviewDraft = {
  sessionId: 'session',
  snapshotId: 'snapshot',
  headSha: 'sha',
  body: '',
  action: 'COMMENT',
  state: 'draft',
  attempt: null,
  submission: null,
  comments: [],
};
const added = {
  ...draft,
  comments: [{ id: 'new', body: 'Замечание к коду', evidence: ref, selected: true }],
};

describe('durable local review comments', () => {
  it('recovers an added comment on reload before the server save finishes', () => {
    const storage = memoryStorage();
    cacheDrafts('session', [added], storage);
    expect(restoreDrafts('session', [draft], storage)).toEqual({
      drafts: [added],
      recovered: true,
    });
    clearDraftCache('session', storage);
    expect(restoreDrafts('session', [added], storage)).toEqual({
      drafts: [added],
      recovered: false,
    });
  });
  it('recovers edits and deletions without resurrecting the server version', () => {
    const storage = memoryStorage();
    cacheDrafts('session', [{ ...added, comments: [] }], storage);
    expect(restoreDrafts('session', [added], storage).drafts[0].comments).toEqual([]);
  });
  it('cannot restore a draft into a different snapshot, commit, session or submitted review', () => {
    const storage = memoryStorage();
    cacheDrafts('session', [added], storage);
    for (const remote of [
      { ...draft, snapshotId: 'other' },
      { ...draft, headSha: 'other' },
      { ...draft, state: 'submitted' as const },
    ]) {
      expect(restoreDrafts('session', [remote], storage)).toEqual({
        drafts: [remote],
        recovered: false,
      });
    }
    expect(restoreDrafts('other', [draft], storage).recovered).toBe(false);
    storage.setItem('review-drafts:session', 'broken-json');
    expect(restoreDrafts('session', [draft], storage).drafts).toEqual([draft]);
  });
  it('saves edits in order and allows a newer save after a failed request', async () => {
    const queue = new DraftSaveQueue(),
      events: string[] = [];
    let release!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue(async () => {
      events.push('older');
      start();
      await gate;
      throw new Error('offline');
    });
    const failure = expect(first).rejects.toThrow('offline');
    const second = queue.enqueue(async () => {
      events.push('newer');
      return added;
    });
    await started;
    expect(events).toEqual(['older']);
    release();
    await failure;
    expect(await second).toEqual(added);
    expect(events).toEqual(['older', 'newer']);
  });
});

describe('inline comment locations in every code view', () => {
  const patch = '@@ -1,3 +1,3 @@\n one\n-old\n+new\n three';
  const changed: ChangedFile = {
    path: 'Service.kt',
    oldPath: 'OldService.kt',
    patch,
    status: 'R',
    addedLines: [2],
    removedLines: [2],
  };
  const comments = [
    ...added.comments,
    {
      id: 'deleted',
      body: 'Удалённая строка',
      selected: false,
      evidence: { ...ref, side: 'base' as const, path: 'OldService.kt', startLine: 2 },
    },
  ];
  it('attaches a multi-line thread only after the last line and scopes it by repo, path and side', () => {
    expect(commentsAtLine(comments, { ...ref, startLine: 1 })).toEqual([]);
    expect(commentsAtLine(comments, { ...ref, startLine: 2 }).map((comment) => comment.id)).toEqual(
      ['new'],
    );
    expect(commentsAtLine(comments, { ...ref, startLine: 2, repoId: 'other' })).toEqual([]);
    expect(commentsAtLine(comments, { ...ref, startLine: 2, side: 'base' })).toEqual([]);
  });
  it('renders added and deleted threads once in both the diff and source drawer', () => {
    const views = [
      React.createElement(Diff, {
        patch,
        repoId: 'repo',
        path: 'Service.kt',
        oldPath: 'OldService.kt',
        comments,
        onSelect: () => {},
      }),
      React.createElement(SourceCode, {
        text: 'one\nnew\nthree\n',
        evidence: ref,
        changedFile: changed,
        comments,
        onSelect: () => {},
      }),
    ];
    for (const view of views) {
      const html = renderToStaticMarkup(view);
      expect(html.split('Замечание к коду')).toHaveLength(2);
      expect(html.split('Удалённая строка')).toHaveLength(2);
      expect(html).toContain('Строки 1–2');
      expect(html).toContain('Не включён в отправку');
    }
  });
});
