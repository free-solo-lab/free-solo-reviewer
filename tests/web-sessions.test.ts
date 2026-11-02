import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateSession, resultIndexes } from '../web/sessions';
import { emptyModelResult, type AnalysisRun, type ReviewSession } from '../shared/model';

afterEach(() => vi.unstubAllGlobals());

const run = (ref: string): AnalysisRun => ({
  id: 'run',
  sessionId: 's',
  version: '1',
  fingerprint: 'f',
  state: 'complete',
  startedAt: '',
  events: [],
  result: { ...emptyModelResult(), contracts: [], indexes: [], indexRefs: [ref] },
});
const session = (ref: string, compared = true): ReviewSession => ({
  id: 's',
  title: 'S',
  createdAt: '',
  snapshots: [],
  run: { ...run(ref), ...(compared && { previousReviewId: 'old' }) },
  history: [{ id: 'old', savedAt: '', snapshots: [], run: { ...run(ref), id: 'old' }, drafts: [] }],
});

describe('session hydration', () => {
  it('downloads each referenced index once and shares it between revisions', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ repoId: 'r', side: 'head', methods: [] }));
    });
    const first = await hydrateSession(session('v:r:head:abc'));
    const second = await hydrateSession(session('v:r:head:abc'));
    expect(requests).toEqual(['/api/indexes/v%3Ar%3Ahead%3Aabc']);
    expect(first.run?.result.indexRefs).toBeUndefined();
    expect(first.run?.result.indexes[0].repoId).toBe('r');
    expect(first.history?.[0].run.result.indexes[0]).toBe(first.run?.result.indexes[0]);
    expect(second.run?.result.indexes[0]).toBe(first.run?.result.indexes[0]);
  });

  it('leaves revisions nobody compares with as references until asked', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ repoId: 'r', side: 'base', methods: [] }));
    });
    const hydrated = await hydrateSession(session('v:r:base:lazy', false));
    const old = hydrated.history![0].run.result;
    expect(old.indexRefs).toEqual(['v:r:base:lazy']);
    expect(old.indexes).toEqual([]);
    // The current run needed the same index, so asking for the old one downloads nothing more.
    expect((await resultIndexes(old))[0]).toBe(hydrated.run?.result.indexes[0]);
    expect(requests).toHaveLength(1);
  });

  it('retries an index whose download failed', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () =>
      ++calls === 1
        ? new Response('{"error":"Индекс не найден."}', { status: 404 })
        : new Response(JSON.stringify({ repoId: 'r', side: 'head', methods: [] })),
    );
    await expect(hydrateSession(session('v:r:head:retry'))).rejects.toThrow('Индекс не найден.');
    await expect(hydrateSession(session('v:r:head:retry'))).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });
});
