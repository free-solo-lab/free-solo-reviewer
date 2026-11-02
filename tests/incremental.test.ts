import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeIncremental } from '../server/incremental';
import { displayedRevision, hasRefreshChanges } from '../shared/review-display';
import {
  emptyModelResult,
  type ReviewRevision,
  type ReviewSession,
  type Snapshot,
  type Finding,
} from '../shared/model';
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
const finding = (id: string, path: string): Finding => ({
  id,
  title: id,
  summary: `Original ${id}`,
  severity: 'medium',
  confidence: 'inferred',
  evidence: [{ repoId: 'r', side: 'head', path, startLine: 1, endLine: 1 }],
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'review-incremental-'));
  cleanup.push(root);
  const before = join(root, 'before'),
    after = join(root, 'after');
  await mkdir(before);
  await mkdir(after);
  for (const path of ['Stable.kt', 'Changed.kt']) {
    await writeFile(join(before, path), 'old code\n');
    await writeFile(join(after, path), path === 'Changed.kt' ? 'new code\n' : 'old code\n');
  }
  const snap = (dir: string): Snapshot =>
    ({
      id: dir,
      repoId: 'r',
      headDir: dir,
      headFiles: ['Stable.kt', 'Changed.kt'],
      baseDir: before,
      baseFiles: [],
      files: [],
    }) as unknown as Snapshot;
  const revision: ReviewRevision = {
    id: 'prior',
    savedAt: '',
    snapshots: [snap(before)],
    drafts: [],
    run: {
      id: 'prior',
      sessionId: 's',
      fingerprint: 'old',
      state: 'complete',
      startedAt: '',
      version: '1',
      events: [],
      result: {
        ...emptyModelResult(),
        summary: 'Original review remains byte-for-byte identical.',
        findings: [finding('stable', 'Stable.kt'), finding('changed', 'Changed.kt')],
        indexes: [],
        contracts: [],
      },
    },
  };
  return { revision, snapshots: [snap(after)] };
}
describe('additive analysis updates', () => {
  it('retains the original summary and unchanged findings while applying only the changed claim', async () => {
    const { revision, snapshots } = await setup(),
      original = JSON.stringify(revision);
    const updated = { ...finding('changed', 'Changed.kt'), summary: 'Only the fix changed' };
    const result = await mergeIncremental(revision, snapshots, {
      ...emptyModelResult(),
      summary: 'Do not replace the original',
      findings: [updated, finding('new', 'Changed.kt')],
    });
    expect(result.summary).toBe(revision.run.result.summary);
    expect(result.findings.map((f) => f.id)).toEqual(['stable', 'changed', 'new']);
    expect(result.findings[0]).toEqual(revision.run.result.findings[0]);
    expect(result.findings[1].summary).toBe('Only the fix changed');
    expect(JSON.stringify(revision)).toBe(original);
  });
  it('never reuses old line references when a file changed and no updated claim was provided', async () => {
    const { revision, snapshots } = await setup();
    const result = await mergeIncremental(revision, snapshots, emptyModelResult());
    expect(result.findings.map((f) => f.id)).toEqual(['stable']);
    expect(result.gaps.join()).toContain('changed');
    expect(revision.run.result.findings).toHaveLength(2);
  });
  it('keeps the original review selected after updates, including after a reload', async () => {
    const { revision, snapshots } = await setup();
    const session = {
      id: 's',
      snapshots,
      history: [revision],
      run: { ...revision.run, id: 'new' },
    } as ReviewSession;
    expect(displayedRevision(session)?.id).toBe('prior');
    expect(displayedRevision(JSON.parse(JSON.stringify(session)))?.id).toBe('prior');
    expect(displayedRevision(session, 'current')).toBeUndefined();
    expect(hasRefreshChanges(session, structuredClone(session))).toBe(false);
    expect(
      hasRefreshChanges(session, { ...session, snapshots: [{ ...snapshots[0], id: 'changed' }] }),
    ).toBe(true);
  });
});
