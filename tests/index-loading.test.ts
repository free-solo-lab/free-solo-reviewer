import { describe, expect, it, vi } from 'vitest';
import { packIndex, unpackIndex } from '../shared/index-wire';
import { Store, indexKey } from '../server/store';
import {
  emptyModelResult,
  type ReviewSession,
  type Snapshot,
  type SourceIndex,
} from '../shared/model';

const at = (path: string, startLine: number, repoId = 'repo', side: 'head' | 'base' = 'head') => ({
  repoId,
  side,
  path,
  startLine,
  endLine: startLine + 1,
});
const index: SourceIndex = {
  version: 'v',
  repoId: 'repo',
  side: 'head',
  errors: [],
  filesIndexed: 2,
  types: [
    {
      name: 'A',
      qualifiedName: 'x.A',
      kind: 'class',
      parents: [],
      imports: [],
      evidence: at('A.java', 1),
    },
  ],
  methods: [
    {
      owner: 'A',
      name: 'run',
      signature: 'void run()',
      annotations: [],
      calls: ['b.go'],
      evidence: at('A.java', 3),
      callSites: [
        {
          name: 'go',
          receiver: 'b',
          evidence: at('A.java', 4),
          transactionIds: [],
          database: false,
        },
        {
          name: 'far',
          receiver: 'c',
          evidence: at('C.java', 9),
          transactionIds: [],
          database: true,
        },
        {
          name: 'other',
          receiver: 'd',
          evidence: at('D.java', 2, 'other'),
          transactionIds: [],
          database: false,
        },
      ],
      programmaticTransactions: [
        {
          id: 't',
          api: 'tx',
          evidence: at('A.java', 5),
          callback: true,
          asynchronous: false,
          nested: false,
        },
      ],
    },
  ],
};

describe('loading source indexes', () => {
  it('sends indexes without repeated places and restores them exactly', () => {
    const packed = packIndex(index);
    const call = packed.methods[0].callSites!;
    expect(call[0].evidence).toEqual([4, 5]);
    expect(call[1].evidence).toEqual(['C.java', 9, 10]);
    expect(call[2].evidence).toEqual(at('D.java', 2, 'other'));
    const sent = JSON.parse(JSON.stringify(packed));
    expect(unpackIndex(sent)).toEqual(index);
    // The index itself and the one evidence from another repository.
    expect(JSON.stringify(packed).match(/"repoId"/g)).toHaveLength(2);
    // Indexes from an older server pass through unchanged.
    expect(unpackIndex(index)).toBe(index);
  });

  it('reads stored indexes of a session only when something uses them', () => {
    const store = new Store(':memory:');
    const snapshot = { id: 's', repoId: 'repo', headSha: 'h', mergeBase: 'm' } as Snapshot;
    const ref = indexKey('v', snapshot, 'head');
    store.saveIndex(ref, index);
    const session: ReviewSession = {
      id: 'session',
      title: '',
      createdAt: '',
      snapshots: [snapshot],
      run: {
        id: 'run',
        sessionId: 'session',
        state: 'complete',
        version: '1',
        fingerprint: 'f',
        startedAt: '',
        events: [],
        result: { ...emptyModelResult(), indexes: [index], contracts: [] },
      },
    };
    store.saveSession(session);
    const read = vi.spyOn(store, 'index');

    // Saving a session that nobody read the indexes of keeps the same references.
    const loaded = store.session('session')!;
    store.saveSession(loaded);
    expect(read).not.toHaveBeenCalled();
    expect(store.detachSession(store.session('session')!).run!.result.indexRefs).toEqual([ref]);

    const again = store.session('session')!;
    expect(again.run!.result.indexes).toEqual([index]);
    expect(read).toHaveBeenCalledTimes(1);
    // Read once, then the same array: callers may add to it.
    again.run!.result.indexes.push({ ...index, side: 'base' });
    expect(again.run!.result.indexes).toHaveLength(2);
    expect(store.detachSession(again).run!.result.indexRefs).toEqual([
      ref,
      indexKey('v', snapshot, 'base'),
    ]);
  });
});
