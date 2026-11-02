import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { indexSnapshot } from '../server/indexer';
import { missingTestMethods } from '../shared/test-coverage';
import { fixture } from './fixtures';
import { createSnapshot } from '../server/repository';
import { Store } from '../server/store';
import { AnalysisManager } from '../server/analysis';
import { buildContext } from '../server/provider';
import { validateModelResult } from '../server/validation';
import { mergeIncremental } from '../server/incremental';
import {
  emptyModelResult,
  TEST_ANALYSIS_VERSION,
  type ReviewTest,
  type ReviewSession,
  type ReviewRevision,
} from '../shared/model';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const path = 'src/test/kotlin/TinyTest.kt';
  await mkdir(join(snapshot.headDir, 'src/test/kotlin'), { recursive: true });
  await writeFile(
    join(snapshot.headDir, path),
    'class TinyTest {\n @Test\n fun accepts() {\n  every { repository.find("id-1") } returns Request("id-1")\n  val result = service.accept(Request("id-1"))\n  assertEquals("ok", result.status)\n }\n}\n',
  );
  snapshot.headFiles.push(path);
  snapshot.files.push({
    path,
    status: 'A',
    patch: '',
    addedLines: [3, 4, 5, 6, 7],
    removedLines: [],
  });
  const ref = { repoId: snapshot.repoId, side: 'head' as const, path, startLine: 3, endLine: 7 };
  const test: ReviewTest = {
    id: 'accepts',
    method: 'accepts',
    title: 'Принимает запрос',
    summary: 'Проверяет успешный ответ с подготовленным мок-репозиторием.',
    confidence: 'inferred',
    evidence: [ref],
    steps: [
      {
        id: 'mock',
        from: 'TinyTest',
        to: 'Repository',
        kind: 'mock',
        label: 'find("id-1") → Request',
        evidence: [{ ...ref, startLine: 4, endLine: 4 }],
        data: [
          {
            role: 'mock',
            label: 'Ответ репозитория',
            type: 'Request',
            value: 'Request("id-1")',
            evidence: [{ ...ref, startLine: 4, endLine: 4 }],
          },
        ],
      },
      {
        id: 'call',
        from: 'TinyTest',
        to: 'Service',
        kind: 'call',
        label: 'accept(Request)',
        evidence: [{ ...ref, startLine: 5, endLine: 5 }],
        data: [],
      },
      {
        id: 'assert',
        from: 'TinyTest',
        to: 'TinyTest',
        kind: 'assertion',
        label: 'assertEquals("ok", status)',
        evidence: [{ ...ref, startLine: 6, endLine: 6 }],
        data: [],
      },
    ],
  };
  return { ...f, snapshot, test };
}
describe('test review analysis', () => {
  it('continues the same saved model request after a quota failure and manager restart', async () => {
    const f = await setup();
    const store = new Store(join(f.root, 'resume.sqlite'));
    cleanup.push(() => store.close());
    const session: ReviewSession = {
      id: 'resume',
      title: 'Resume',
      createdAt: '',
      snapshots: [f.snapshot],
      run: null,
    };
    store.saveSession(session);
    let calls = 0;
    const provider = {
      id: 'resume-provider',
      async analyze(input: import('../server/provider').AnalysisInput) {
        calls++;
        expect(input.testsOnly).toBeUndefined();
        if (calls === 1) {
          input.continuation!.checkpoint.threadId = 'saved-cli-thread';
          input.continuation!.save();
          throw new Error('You have hit your usage limit');
        }
        expect(input.continuation?.checkpoint.threadId).toBe('saved-cli-thread');
        return { ...emptyModelResult(), summary: 'Completed review', tests: [f.test] };
      },
    };
    const manager = new AnalysisManager(store, provider);
    cleanup.push(() => manager.stopAll());
    manager.start(session);
    for (let i = 0; i < 200 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const paused = store.session(session.id)!;
    expect(paused.run?.checkpoint?.stage).toBe('review');
    expect(paused.run?.checkpoint?.pending?.threadId).toBe('saved-cli-thread');
    const runId = paused.run!.id,
      eventCount = paused.run!.events.length;
    paused.snapshots[0].headSha = 'a'.repeat(40); // Same source, different commit metadata.
    const resumed = new AnalysisManager(store, provider);
    cleanup.push(() => resumed.stopAll());
    resumed.resume(paused);
    expect(() => resumed.resume(paused)).toThrow('выполняется');
    for (let i = 0; i < 200 && resumed.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = store.session(session.id)!;
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.id).toBe(runId);
    expect(saved.run?.result.summary).toBe('Completed review');
    expect(saved.run?.events.length).toBeGreaterThan(eventCount);
    expect(saved.history).toBeUndefined();
    expect(saved.update).toBeUndefined();
    expect(saved.run?.checkpoint?.pending).toBeUndefined();
    expect(
      new Set(saved.run!.result.indexes.map((index) => `${index.repoId}:${index.side}`)).size,
    ).toBe(saved.run!.result.indexes.length);
    resumed.resume(saved);
    expect(calls).toBe(2);
    saved.snapshots[0].headSha = 'b'.repeat(40);
    resumed.resume(saved);
    expect(calls).toBe(2); // A different commit with identical source is already analyzed.
    saved.snapshots[0].contentHash = 'different-source';
    expect(() => resumed.resume(saved)).toThrow('Версия кода');
  });
  it('validates test call sites and mock data, dropping invalid references and production internals', async () => {
    const f = await setup();
    const test = structuredClone(f.test);
    test.steps[0].data.push({
      ...test.steps[0].data[0],
      evidence: [{ ...test.evidence[0], path: 'missing.kt' }],
    });
    test.steps.push({
      ...test.steps[1],
      id: 'internal',
      evidence: [
        {
          repoId: f.snapshot.repoId,
          side: 'head',
          path: 'src/main/java/example/OrderService.java',
          startLine: 7,
          endLine: 9,
        },
      ],
    });
    const result = await validateModelResult({ ...emptyModelResult(), tests: [test] }, [
      f.snapshot,
    ]);
    expect(result.tests?.[0].steps).toHaveLength(3);
    expect(result.tests?.[0].steps[0].data).toHaveLength(1);
    expect(result.gaps.length).toBeGreaterThan(0);
  });
  it('enriches only tests, supports cancellation/retry and does not rerun completed test analysis', async () => {
    const f = await setup(),
      store = new Store(join(f.root, 'tests.sqlite'));
    cleanup.push(() => store.close());
    const baseline = {
      ...emptyModelResult(),
      summary: 'Original overview',
      indexes: [],
      contracts: [],
      database: [
        {
          id: 'sql',
          title: 'SQL',
          summary: '',
          confidence: 'inferred' as const,
          kind: 'sql' as const,
          sql: 'select 1',
          dialect: '',
          tables: [],
          unknowns: [],
          evidence: f.test.evidence,
        },
      ],
    };
    const session: ReviewSession = {
      id: 'test-review',
      title: 'Tests',
      createdAt: '',
      snapshots: [f.snapshot],
      run: {
        id: 'run',
        sessionId: 'test-review',
        fingerprint: 'old',
        version: '1',
        state: 'complete',
        startedAt: '',
        events: [],
        // An earlier interrupted attempt left its error among the gaps.
        result: { ...baseline, gaps: [...baseline.gaps, 'Codex/анализ: usage limit'] },
      },
    };
    store.saveSession(session);
    let calls = 0;
    const manager = new AnalysisManager(store, {
      id: 'tests',
      async analyze(input, signal) {
        calls++;
        expect(input.testsOnly).toBe(true);
        expect(input.sqlOnly).toBeUndefined();
        if (calls === 1)
          return new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          );
        return { ...emptyModelResult(), summary: 'Must not overwrite overview', tests: [f.test] };
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.startTests(session);
    for (let i = 0; i < 300 && calls === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    manager.cancel(session.id);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.session(session.id)?.run?.state).toBe('cancelled');
    manager.startTests(store.session(session.id)!);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = store.session(session.id)!;
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.result.summary).toBe(baseline.summary);
    expect(saved.run?.result.database).toEqual(baseline.database);
    expect(saved.run?.result.tests).toEqual([f.test]);
    expect(saved.run?.result.gaps).toEqual(baseline.gaps);
    expect(saved.history).toBeUndefined();
    manager.startTests(saved);
    expect(calls).toBe(2);
    expect(store.analysisResult(saved.run!.fingerprint)?.tests).toHaveLength(1);
  });
  it('prioritizes test source and fixtures in tests-only context', async () => {
    const f = await setup();
    const context = JSON.parse(
      (await buildContext({ snapshots: [f.snapshot], indexes: [], testsOnly: true })).text,
    );
    expect(context.testsOnly).toBe(true);
    expect(context.sources[0].path).toMatch(/test/);
    expect(
      context.sources.some((source: { text: string }) => source.text.includes('Request("id-1")')),
    ).toBe(true);
  });
  it('automatically fills missing tests after the initial review response', async () => {
    const f = await setup(),
      store = new Store(join(f.root, 'initial-tests.sqlite'));
    cleanup.push(() => store.close());
    const session: ReviewSession = {
      id: 'initial-tests',
      title: 'Review',
      createdAt: '',
      snapshots: [f.snapshot],
      run: null,
    };
    store.saveSession(session);
    const modes: boolean[] = [];
    const manager = new AnalysisManager(store, {
      id: 'initial-test-provider',
      async analyze(input) {
        modes.push(!!input.testsOnly);
        return input.testsOnly
          ? { ...emptyModelResult(), tests: [f.test] }
          : { ...emptyModelResult(), summary: 'Initial review' };
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.start(session);
    for (let i = 0; i < 300 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = store.session(session.id)!;
    expect(modes).toEqual([false, true]);
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.result.summary).toBe('Initial review');
    expect(saved.run?.result.tests).toEqual([f.test]);
    expect(saved.run?.result.testAnalysisVersion).toBe(TEST_ANALYSIS_VERSION);
  });
  it('repairs a falsely complete catalog while keeping the existing test and other review sections', async () => {
    const f = await setup();
    const path = f.test.evidence[0].path,
      file = join(f.snapshot.headDir, path);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        /}\n$/,
        ' @Test\n fun rejects() {\n  assertFails { service.accept(null) }\n }\n}\n',
      ),
    );
    const index = await indexSnapshot(f.snapshot, 'head');
    const target = index.methods.find((m) => m.name === 'rejects')!;
    const store = new Store(join(f.root, 'test-coverage.sqlite'));
    cleanup.push(() => store.close());
    const session: ReviewSession = {
      id: 'coverage',
      title: 'Tests',
      createdAt: '',
      snapshots: [f.snapshot],
      run: {
        id: 'old',
        sessionId: 'coverage',
        fingerprint: 'old',
        version: '1',
        state: 'complete',
        startedAt: '',
        events: [],
        result: {
          ...emptyModelResult(),
          summary: 'Preserve summary',
          indexes: [index],
          contracts: [],
          tests: [f.test],
          testAnalysisVersion: TEST_ANALYSIS_VERSION,
        },
      },
    };
    store.saveSession(session);
    let calls = 0;
    const manager = new AnalysisManager(store, {
      id: 'test-coverage',
      async analyze(input) {
        calls++;
        expect(input.testTargets?.map((m) => m.name)).toEqual(['rejects']);
        return {
          ...emptyModelResult(),
          tests:
            calls === 1
              ? []
              : [
                  {
                    ...f.test,
                    id: f.test.id,
                    method: 'rejects',
                    evidence: [target.evidence],
                    steps: [{ ...f.test.steps[2], evidence: [target.evidence] }],
                  },
                ],
        };
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.startTests(session);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const partial = store.session(session.id)!;
    expect(partial.run?.state).toBe('partial');
    expect(partial.run?.result.tests).toEqual([f.test]);
    manager.startTests(partial);
    for (let i = 0; i < 100 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = store.session(session.id)!;
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.result.summary).toBe('Preserve summary');
    expect(saved.run?.result.tests?.[0]).toEqual(f.test);
    expect(saved.run?.result.tests).toHaveLength(2);
    expect(new Set(saved.run!.result.tests!.map((t) => t.id)).size).toBe(2);
    expect(
      missingTestMethods(saved.snapshots, saved.run!.result.indexes, saved.run!.result.tests!),
    ).toEqual([]);
    manager.startTests(saved);
    expect(calls).toBe(2);
  });
  it('persists completed batches and retries only the remaining methods after a later failure', async () => {
    const f = await setup(),
      file = join(f.snapshot.headDir, f.test.evidence[0].path);
    const extra = Array.from(
      { length: 42 },
      (_, i) => ` @Test\n fun case${i}() { assertTrue(true) }\n`,
    ).join('');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/}\n$/, `${extra}}\n`));
    const index = await indexSnapshot(f.snapshot, 'head'),
      store = new Store(join(f.root, 'test-batches.sqlite'));
    cleanup.push(() => store.close());
    const session: ReviewSession = {
      id: 'batches',
      title: 'Tests',
      createdAt: '',
      snapshots: [f.snapshot],
      run: {
        id: 'old',
        sessionId: 'batches',
        fingerprint: 'old',
        version: '1',
        state: 'complete',
        startedAt: '',
        events: [],
        result: {
          ...emptyModelResult(),
          summary: 'Keep',
          indexes: [index],
          contracts: [],
          tests: [f.test],
          testAnalysisVersion: TEST_ANALYSIS_VERSION,
        },
      },
    };
    store.saveSession(session);
    const sizes: number[] = [];
    const manager = new AnalysisManager(store, {
      id: 'batch-test',
      async analyze(input) {
        sizes.push(input.testTargets!.length);
        if (sizes.length === 2) throw new Error('Second batch failed');
        return {
          ...emptyModelResult(),
          tests: input.testTargets!.map((method) => ({
            ...f.test,
            id: method.name,
            method: method.name,
            evidence: [method.evidence],
            steps: [{ ...f.test.steps[2], label: 'assertTrue(true)', evidence: [method.evidence] }],
          })),
        };
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.startTests(session);
    for (let i = 0; i < 200 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const partial = store.session(session.id)!;
    expect(partial.run?.state).toBe('partial');
    expect(partial.run?.result.tests).toHaveLength(41);
    const kept = structuredClone(partial.run!.result.tests);
    const runId = partial.run!.id,
      eventCount = partial.run!.events.length;
    // Existing saved reviews have no checkpoint, but their completed batches must survive too.
    delete partial.run!.checkpoint;
    manager.resume(partial);
    for (let i = 0; i < 200 && manager.isRunning(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = store.session(session.id)!;
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.result.tests?.slice(0, 41)).toEqual(kept);
    expect(saved.run?.result.tests).toHaveLength(43);
    expect(sizes).toEqual([40, 2, 2]);
    expect(saved.run?.id).toBe(runId);
    expect(saved.run!.events.length).toBeGreaterThan(eventCount);
    expect(saved.history).toBeUndefined();
  });
  it('does not carry stale mock data when its fixture file changes after the review', async () => {
    const f = await setup();
    const next = await createSnapshot(f.repo, 12, join(f.root, 'next-snapshots'), f.github);
    const fixturePath = 'src/test/kotlin/Fixture.kt';
    for (const snapshot of [f.snapshot, next]) {
      await mkdir(join(snapshot.headDir, 'src/test/kotlin'), { recursive: true });
      snapshot.headFiles.push(fixturePath);
    }
    await writeFile(join(f.snapshot.headDir, fixturePath), 'val request = Request("old")');
    await writeFile(join(next.headDir, fixturePath), 'val request = Request("new")');
    next.headFiles.push(f.test.evidence[0].path);
    await writeFile(
      join(next.headDir, f.test.evidence[0].path),
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(f.snapshot.headDir, f.test.evidence[0].path)),
      ),
    );
    f.test.steps[0].data[0].evidence = [
      { ...f.test.evidence[0], path: fixturePath, startLine: 1, endLine: 1 },
    ];
    const revision: ReviewRevision = {
      id: 'prior',
      savedAt: '',
      snapshots: [f.snapshot],
      drafts: [],
      run: {
        id: 'prior',
        sessionId: 's',
        version: '1',
        fingerprint: '',
        state: 'complete',
        startedAt: '',
        events: [],
        result: { ...emptyModelResult(), tests: [f.test], indexes: [], contracts: [] },
      },
    };
    const merged = await mergeIncremental(revision, [next], { ...emptyModelResult(), tests: [] });
    expect(merged.tests).toEqual([]);
    expect(merged.gaps.join()).toContain(f.test.title);
  });
});
