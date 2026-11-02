import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { createSnapshot } from '../server/repository';
import { Store } from '../server/store';
import { AnalysisManager } from '../server/analysis';
import { buildContext, type AnalysisProvider } from '../server/provider';
import { scenarioRoots, missingScenarios } from '../shared/scenario-coverage';
import {
  emptyModelResult,
  type Evidence,
  type ReviewSession,
  type Scenario,
  type SourceIndex,
} from '../shared/model';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const path = 'src/main/kotlin/InvoiceController.kt';
  await mkdir(join(snapshot.headDir, 'src/main/kotlin'), { recursive: true });
  await writeFile(
    join(snapshot.headDir, path),
    'class InvoiceController {\n fun read() {\n  service.read()\n }\n fun upload() {\n  service.upload()\n }\n private fun helper() {}\n}\n',
  );
  snapshot.headFiles.push(path);
  snapshot.files.push({
    path,
    status: 'A',
    patch: '',
    addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    removedLines: [],
  });
  const ref = (startLine: number, endLine = startLine): Evidence => ({
    repoId: snapshot.repoId,
    side: 'head',
    path,
    startLine,
    endLine,
  });
  const index: SourceIndex = {
    repoId: snapshot.repoId,
    side: 'head',
    filesIndexed: 1,
    errors: [],
    methods: [
      {
        name: 'read',
        signature: 'fun read()',
        calls: ['service.read'],
        annotations: [],
        evidence: ref(2, 4),
      },
      {
        name: 'upload',
        signature: 'fun upload()',
        calls: ['service.upload'],
        annotations: [],
        evidence: ref(5, 7),
      },
      {
        name: 'helper',
        signature: 'private fun helper()',
        calls: [],
        annotations: [],
        evidence: ref(8),
      },
    ],
  };
  const scenario = (name: string, evidence: Evidence): Scenario => ({
    id: name,
    title: name,
    summary: '',
    confidence: 'inferred',
    evidence: [ref(1, 9)],
    services: [snapshot.repoId],
    steps: [
      {
        id: `${name}-step`,
        label: name,
        kind: 'call',
        change: 'added',
        branch: '',
        confidence: 'inferred',
        from: snapshot.repoId,
        to: snapshot.repoId,
        evidence: [evidence],
      },
    ],
  });
  const read = scenario('read', ref(3)),
    upload = scenario('upload', ref(6));
  const session: ReviewSession = {
    id: 'coverage-session',
    title: 'Keep review',
    createdAt: new Date().toISOString(),
    snapshots: [snapshot],
    run: {
      id: 'baseline',
      sessionId: 'coverage-session',
      version: 'v',
      fingerprint: 'baseline-key',
      state: 'complete',
      startedAt: new Date().toISOString(),
      events: [],
      result: {
        ...emptyModelResult(),
        summary: 'Keep this summary',
        contracts: [],
        indexes: [index],
        scenarios: [read],
        findings: [
          {
            id: 'finding',
            title: 'Keep finding',
            summary: '',
            confidence: 'inferred',
            severity: 'low',
            evidence: [ref(3)],
          },
        ],
      },
    },
  };
  const store = new Store(join(f.root, 'coverage.sqlite'));
  cleanup.push(() => store.close());
  store.saveSession(session);
  store.saveDraft({
    sessionId: session.id,
    snapshotId: snapshot.id,
    headSha: snapshot.headSha,
    body: 'Reviewer body',
    action: 'COMMENT',
    comments: [{ id: 'comment', body: 'Keep my comment', evidence: ref(3), selected: true }],
    state: 'draft',
    attempt: null,
    submission: null,
  });
  return { f, snapshot, session, store, index, read, upload };
}
async function finished(manager: AnalysisManager, id: string) {
  for (let i = 0; i < 200 && manager.isRunning(id); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(manager.isRunning(id)).toBe(false);
}

describe('scenario catalog completeness', () => {
  it('checks changed public library methods without requesting unchanged methods or private helpers', async () => {
    const { snapshot, index } = await setup();
    const path = 'packages/libs/fraudo/src/main/java/RulesVisitor.java';
    snapshot.headFiles.push(path);
    snapshot.files = [{ path, status: 'M', patch: '', addedLines: [3, 13], removedLines: [] }];
    index.methods = [
      {
        name: 'visitPayout',
        signature: 'public Result visitPayout()',
        calls: [],
        annotations: [],
        evidence: { repoId: snapshot.repoId, side: 'head', path, startLine: 2, endLine: 5 },
      },
      {
        name: 'unchanged',
        signature: 'public Result unchanged()',
        calls: [],
        annotations: [],
        evidence: { repoId: snapshot.repoId, side: 'head', path, startLine: 7, endLine: 10 },
      },
      {
        name: 'helper',
        signature: 'private Result helper()',
        calls: [],
        annotations: [],
        evidence: { repoId: snapshot.repoId, side: 'head', path, startLine: 12, endLine: 15 },
      },
    ];
    const roots = scenarioRoots([snapshot], [index]);
    expect(roots.map((r) => r.name)).toEqual(['RulesVisitor.visitPayout']);
    expect(missingScenarios(roots, [])).toHaveLength(1);
  });
  it('marks an older cached partial catalog as partial without making any model request', async () => {
    const { session, store } = await setup();
    let calls = 0;
    const manager = new AnalysisManager(store, {
      id: 'coverage',
      analyze: async () => {
        calls++;
        return emptyModelResult();
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.restoreCached(session);
    expect(session.run?.state).toBe('partial');
    expect(session.run?.scenariosBaseState).toBe('complete');
    expect(session.run?.result.scenarios).toHaveLength(1);
    expect(calls).toBe(0);
  });
  it('checks individual entries rather than broad scenario summary references, and skips private wrappers', async () => {
    const { snapshot, index, read } = await setup();
    const roots = scenarioRoots([snapshot], [index]);
    expect(roots.map((root) => root.name)).toEqual([
      'InvoiceController.read',
      'InvoiceController.upload',
    ]);
    expect(missingScenarios(roots, [read]).map((root) => root.name)).toEqual([
      'InvoiceController.upload',
    ]);
  });
  it('appends missing scenarios without replacing findings, the existing diagram or drafts; repeat is cached', async () => {
    const { session, store, upload, read } = await setup();
    const drafts = structuredClone(store.drafts(session.id));
    let calls = 0;
    const provider: AnalysisProvider = {
      id: 'coverage',
      analyze: async (input) => {
        calls++;
        expect(input.scenariosOnly?.map((root) => root.name)).toEqual(['InvoiceController.upload']);
        return {
          ...emptyModelResult(),
          summary: 'Must not replace',
          scenarios: [{ ...upload, id: read.id }],
        };
      },
    };
    const manager = new AnalysisManager(store, provider);
    cleanup.push(() => manager.stopAll());
    manager.startScenarios(session);
    await finished(manager, session.id);
    expect(session.run?.state).toBe('complete');
    expect(session.run?.result.summary).toBe('Keep this summary');
    expect(session.run?.result.findings[0].id).toBe('finding');
    expect(session.run?.result.scenarios[0]).toEqual(read);
    expect(session.run?.result.scenarios).toHaveLength(2);
    expect(new Set(session.run?.result.scenarios.map((scenario) => scenario.id)).size).toBe(2);
    expect(store.drafts(session.id)).toEqual(drafts);
    manager.startScenarios(session);
    expect(calls).toBe(1);
  });
  it('keeps incomplete catalogs partial and retries only their missing entries', async () => {
    const { session, store, upload } = await setup();
    let attempts = 0;
    const manager = new AnalysisManager(store, {
      id: 'coverage',
      analyze: async () => ({ ...emptyModelResult(), scenarios: ++attempts === 1 ? [] : [upload] }),
    });
    cleanup.push(() => manager.stopAll());
    manager.startScenarios(session);
    await finished(manager, session.id);
    expect(session.run?.state).toBe('partial');
    expect(store.analysisResult('baseline-key')).toBeUndefined();
    expect(session.run?.result.scenarios).toHaveLength(1);
    manager.startScenarios(session);
    await finished(manager, session.id);
    expect(session.run?.state).toBe('complete');
    expect(session.run?.result.scenarios).toHaveLength(2);
  });
  it('retains the full method catalog in compact context instead of spending the index budget on repeated sites', async () => {
    const { snapshot, index } = await setup();
    index.methods = Array.from({ length: 100 }, (_, n) => ({
      ...index.methods[0],
      name: `method${n}`,
      callSites: Array.from({ length: 100 }, () => ({
        name: 'read',
        receiver: 'service',
        transactionIds: [],
        database: false,
        evidence: index.methods[0].evidence,
      })),
    }));
    const context = JSON.parse(
      (await buildContext({ snapshots: [snapshot], indexes: [index] })).text,
    );
    expect(context.indexes[0].methods).toHaveLength(100);
  });
});
