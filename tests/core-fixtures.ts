import { afterEach } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { createSnapshot } from '../server/repository.js';
import { Store } from '../server/store.js';
import { ReviewManager } from '../server/review.js';
import { emptyModelResult, type ReviewSession } from '../shared/model.js';
/** Shared by the core suites; each test file gets its own copy of this module. */
export const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
export async function setup() {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  return { ...f, snapshot };
}
export async function reviewFixture() {
  const f = await setup();
  const store = new Store(join(f.root, 'review.sqlite'));
  cleanup.push(() => store.close());
  const session: ReviewSession = {
    id: randomUUID(),
    title: 'Review',
    createdAt: new Date().toISOString(),
    snapshots: [f.snapshot],
    run: {
      id: 'run',
      sessionId: 'session',
      version: '1',
      fingerprint: 'hash',
      state: 'complete',
      startedAt: new Date().toISOString(),
      events: [],
      result: { ...emptyModelResult(), indexes: [], contracts: [] },
    },
  };
  store.saveSession(session);
  const manager = new ReviewManager(store, f.github);
  const changed = f.snapshot.files.find((f) => f.path.endsWith('OrderService.java'))!;
  const evidence = {
    repoId: f.repo.id,
    side: 'head' as const,
    path: changed.path,
    startLine: changed.addedLines[0],
    endLine: changed.addedLines[0],
  };
  return { ...f, store, session, manager, evidence };
}
export async function waitFor(condition: () => boolean) {
  const until = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > until) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
