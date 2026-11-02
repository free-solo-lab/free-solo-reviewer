import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixture } from './fixtures';
import { createSnapshot } from '../server/repository';
import { AnalysisManager, tokensSince } from '../server/analysis';
import { indexSnapshot } from '../server/indexer';
import { Store } from '../server/store';
import { emptyModelResult, type IndexedMethod, type ReviewSession } from '../shared/model';
import { scenarioRoots } from '../shared/scenario-coverage';
import type { AnalysisInput } from '../server/provider';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};
async function setup() {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const store = new Store(join(f.root, 'conversation.sqlite'));
  cleanup.push(() => store.close());
  const session: ReviewSession = {
    id: 'chat',
    title: 'Chat',
    createdAt: '',
    snapshots: [snapshot],
    run: null,
  };
  store.saveSession(session);
  return { ...f, snapshot, store, session };
}
describe('token accounting', () => {
  it('counts only the growth of a thread total, and a fresh total in full', () => {
    const first = { input: 600, cached: 500, output: 20 };
    expect(tokensSince(undefined, first)).toEqual(first);
    expect(tokensSince(first, { input: 980, cached: 870, output: 35 })).toEqual({
      input: 380,
      cached: 370,
      output: 15,
    });
    expect(tokensSince(first, { input: 90, cached: 10, output: 5 })).toEqual({
      input: 90,
      cached: 10,
      output: 5,
    });
  });
});
describe('analysis conversation and stage order', () => {
  it('commits diagrams before SQL and tests, each stage in a fresh thread of one workspace', async () => {
    const f = await setup();
    const add = async (path: string, text: string) => {
      await mkdir(join(f.snapshot.headDir, path, '..'), { recursive: true });
      await writeFile(join(f.snapshot.headDir, path), text);
      f.snapshot.headFiles.push(path);
      f.snapshot.files.push({
        path,
        status: 'A',
        patch: '',
        addedLines: [1, 2, 3, 4, 5, 6, 7, 8],
        removedLines: [],
      });
    };
    await add(
      'src/main/QueryRepository.kt',
      'class QueryRepository(private val dsl: DSLContext) {\n fun find(): String {\n  return dsl.select(ID).from(RECORD).fetchOne()\n }\n}\n',
    );
    await add(
      'src/main/QueryController.kt',
      'class QueryController {\n fun read(): String {\n  return queryRepository.find()\n }\n}\n',
    );
    await add(
      'src/test/QueryTest.kt',
      'class QueryTest {\n @Test\n fun reads() {\n  assertEquals("ok", queryController.read())\n }\n}\n',
    );
    const modes: string[] = [];
    let cardCalls = 0;
    const manager = new AnalysisManager(f.store, {
      id: 'fake-local',
      async describeChanges(units, _signal, onEvent) {
        cardCalls++;
        onEvent?.({
          type: 'turn.completed',
          usage: {
            input_tokens: 40,
            cached_input_tokens: 10,
            output_tokens: 5,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        });
        return units.map(() => undefined);
      },
      async analyze(input) {
        const pending = input.continuation!.checkpoint;
        if (modes.length) {
          expect(pending.home).toBe(join(f.root, 'conversation'));
          expect(pending.threadId).toBeUndefined();
        }
        pending.home = join(f.root, 'conversation');
        pending.threadId = `thread-${modes.length}`;
        pending.localWorkspace = true;
        input.continuation!.save();
        const result = emptyModelResult();
        if (input.testsOnly) {
          expect(f.store.session('chat')!.run!.result.database.some((op) => op.query)).toBe(true);
          modes.push('tests');
          result.tests = input.testTargets!.map((m) => ({
            id: m.name,
            method: m.name,
            title: 'Чтение',
            summary: 'Проверяет чтение.',
            confidence: 'inferred',
            evidence: [m.evidence],
            steps: [],
          }));
        } else if (input.sqlOnly) {
          expect(f.store.session('chat')!.run!.result.scenarios).toHaveLength(1);
          modes.push('sql');
          result.database = input.sqlTargets!.map((m) => ({
            id: m.name,
            title: 'SELECT',
            summary: 'Выборка',
            confidence: 'inferred',
            kind: 'jooq',
            sql: 'SELECT id\nFROM record',
            dialect: 'unknown',
            tables: ['record'],
            unknowns: [],
            evidence: [m.evidence],
            query: { method: m.name, framework: 'jooq', evidence: m.evidence, parameters: [] },
          }));
        } else {
          // Two reports from one thread carry running totals, not per-turn amounts.
          for (const [input_tokens, cached_input_tokens, output_tokens] of [
            [100, 40, 20],
            [250, 140, 50],
          ])
            input.onEvent?.({
              type: 'turn.completed',
              usage: {
                input_tokens,
                cached_input_tokens,
                output_tokens,
                cache_write_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            });
          modes.push('diagrams');
          result.summary = 'Изменения чтения';
          const m = input.indexes
            .flatMap((i) => i.methods)
            .find((m) => m.evidence.side === 'head' && m.name === 'read')!;
          result.scenarios = [
            {
              id: 'read',
              title: 'Чтение',
              summary: 'Чтение записи',
              confidence: 'inferred',
              evidence: [m.evidence],
              services: [f.repo.id],
              steps: [
                {
                  id: 'read',
                  kind: 'call',
                  label: 'QueryController.read -> QueryRepository.find',
                  from: f.repo.id,
                  to: f.repo.id,
                  confidence: 'inferred',
                  evidence: [m.evidence],
                  change: 'added',
                  branch: '',
                },
              ],
            },
          ];
        }
        return result;
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.start(f.session);
    await wait(() => !manager.isRunning('chat'));
    const saved = f.store.session('chat')!;
    expect(saved.run?.error).toBeUndefined();
    expect(saved.run?.state).toBe('complete');
    expect(modes).toEqual(['diagrams', 'sql', 'tests']);
    expect(saved.run?.conversation).toEqual({ home: join(f.root, 'conversation') });
    expect(saved.run?.usage).toEqual({
      input: 250 + 40 * cardCalls,
      cached: 140 + 10 * cardCalls,
      output: 50 + 5 * cardCalls,
    });
    const stats = f.store.analysisStatistics();
    expect(stats).toHaveLength(1);
    expect(stats[0].status).toBe('complete');
    expect(stats[0].requests.filter((r) => r.stage === 'changes')).toHaveLength(cardCalls);
    expect(stats[0].requests.find((r) => r.stage === 'review')?.usage).toEqual({
      input: 250,
      cached: 140,
      output: 50,
    });
    expect(stats[0].requests.map((r) => r.stage)).toEqual([
      ...Array(cardCalls).fill('changes'),
      'review',
      'sql',
      'tests',
    ]);
  });
  it('builds SQL and diagrams on request for one method when the settings say so', async () => {
    const f = await setup();
    const add = async (path: string, text: string) => {
      await mkdir(join(f.snapshot.headDir, path, '..'), { recursive: true });
      await writeFile(join(f.snapshot.headDir, path), text);
      f.snapshot.headFiles.push(path);
      f.snapshot.files.push({
        path,
        status: 'A',
        patch: '',
        addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        removedLines: [],
      });
    };
    await add(
      'src/main/QueryRepository.kt',
      'class QueryRepository(private val dsl: DSLContext) {\n fun find(): String {\n  return dsl.select(ID).from(RECORD).fetchOne()\n }\n fun findAll(): String {\n  return dsl.select(ID).from(RECORD).fetch()\n }\n}\n',
    );
    await add(
      'src/main/QueryController.kt',
      'class QueryController {\n fun read(): String {\n  return queryRepository.find()\n }\n fun list(): String {\n  return queryRepository.findAll()\n }\n}\n',
    );
    f.store.saveOnDemandSteps(['sql', 'scenarios']);
    const inputs: AnalysisInput[] = [];
    const scenario = (m: IndexedMethod) => ({
      id: m.name,
      title: m.name,
      summary: '',
      confidence: 'inferred' as const,
      evidence: [m.evidence],
      services: [f.repo.id],
      steps: [
        {
          id: m.name,
          kind: 'call' as const,
          label: m.name,
          from: f.repo.id,
          to: f.repo.id,
          confidence: 'inferred' as const,
          evidence: [m.evidence],
          change: 'added' as const,
          branch: '',
        },
      ],
    });
    const manager = new AnalysisManager(f.store, {
      id: 'on-request',
      async analyze(input) {
        inputs.push(input);
        const result = emptyModelResult();
        const method = (name: string) =>
          input.indexes
            .flatMap((index) => index.methods)
            .find((m) => m.evidence.side === 'head' && m.name === name)!;
        if (input.sqlOnly)
          result.database = input.sqlTargets!.map((m) => ({
            id: m.name,
            title: 'SELECT',
            summary: '',
            confidence: 'inferred',
            kind: 'jooq',
            sql: 'SELECT id\nFROM record',
            dialect: 'unknown',
            tables: ['record'],
            unknowns: [],
            evidence: [m.evidence],
            query: { method: m.name, framework: 'jooq', evidence: m.evidence, parameters: [] },
          }));
        else if (input.scenariosOnly)
          result.scenarios = input.scenariosOnly.map((root) =>
            scenario(method(root.name.split('.').pop()!)),
          );
        else if (!input.testsOnly) {
          result.summary = 'Reading';
          result.scenarios = [scenario(method('read'))];
        }
        return result;
      },
    });
    cleanup.push(() => manager.stopAll());
    manager.start(f.session);
    await wait(() => !manager.isRunning('chat'));
    let saved = f.store.session('chat')!;
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.skippedSteps).toEqual(['scenarios', 'sql']);
    expect(inputs.some((input) => input.sqlOnly || input.scenariosOnly)).toBe(false);
    expect(saved.run?.events.map((event) => event.message).join('\n')).toContain(
      'выполняется по запросу для метода',
    );

    // SQL for the method whose query is open; the other query method stays on request.
    manager.startSql(saved, {
      repoId: f.repo.id,
      side: 'head',
      path: 'src/main/QueryRepository.kt',
      line: 3,
    });
    await wait(() => !manager.isRunning('chat'));
    saved = f.store.session('chat')!;
    expect(inputs.at(-1)?.sqlTargets?.map((m) => m.name)).toEqual(['find']);
    expect(saved.run?.state).toBe('complete');
    expect(
      saved.run?.result.database.flatMap((item) => (item.query ? [item.query.method] : [])),
    ).toEqual(['find']);
    expect(saved.run?.skippedSteps).toContain('sql');
    expect(() =>
      manager.startSql(saved, {
        repoId: f.repo.id,
        side: 'head',
        path: 'src/main/QueryController.kt',
        line: 3,
      }),
    ).toThrow('У этого метода нет изменённых запросов к базе для разбора.');

    // The diagram of one entry method; with it every entry has a diagram, so the stage is done.
    expect(() => manager.startScenarios(saved, 'unknown')).toThrow(
      'Этого входного метода нет среди изменённых сценариев.',
    );
    const root = scenarioRoots(saved.snapshots, saved.run!.result.indexes).find(
      (item) => item.name === 'QueryController.list',
    )!;
    manager.startScenarios(saved, root.id);
    await wait(() => !manager.isRunning('chat'));
    saved = f.store.session('chat')!;
    expect(inputs.at(-1)?.scenariosOnly?.map((item) => item.name)).toEqual([
      'QueryController.list',
    ]);
    expect(saved.run?.state).toBe('complete');
    expect(saved.run?.result.scenarios.map((item) => item.id)).toEqual(['read', 'list']);
    expect(saved.run?.skippedSteps).toEqual(['sql']);
  });
  it('drops the old broad pending request on continuation, preserving results and selecting only changed tests', async () => {
    const f = await setup();
    const path = 'src/test/ReaderTest.kt';
    await mkdir(join(f.snapshot.headDir, path, '..'), { recursive: true });
    await writeFile(
      join(f.snapshot.headDir, path),
      'class ReaderTest {\n @Test\n fun changed() {\n  assertTrue(true)\n }\n @Test\n fun unchanged() {\n  assertTrue(true)\n }\n}\n',
    );
    f.snapshot.headFiles.push(path);
    f.snapshot.files.push({ path, status: 'M', patch: '', addedLines: [4], removedLines: [4] });
    const index = await indexSnapshot(f.snapshot, 'head');
    const unchanged = index.methods.find((m) => m.name === 'unchanged')!;
    let called = 0;
    const manager = new AnalysisManager(f.store, {
      id: 'migration',
      async analyze(input) {
        called++;
        expect(input.testsOnly).toBe(true);
        expect(input.testTargets?.map((m) => m.name)).toEqual(['changed']);
        expect(input.continuation?.checkpoint.threadId).toBeUndefined();
        return {
          ...emptyModelResult(),
          tests: input.testTargets!.map((m) => ({
            id: m.name,
            method: m.name,
            title: 'Changed',
            summary: 'Changed assertion',
            confidence: 'inferred',
            evidence: [m.evidence],
            steps: [],
          })),
        };
      },
    });
    cleanup.push(() => manager.stopAll());
    f.session.run = {
      id: 'paused',
      sessionId: f.session.id,
      version: '0.2.0-local-scope',
      fingerprint: '',
      state: 'cancelled',
      startedAt: '',
      events: [],
      checkpoint: {
        stage: 'tests',
        pending: { key: 'old-wide-request', threadId: 'old-wide-thread', testTargets: [unchanged] },
      },
      result: {
        ...emptyModelResult(),
        summary: 'Preserve review',
        contracts: [],
        indexes: [index],
      },
    };
    f.session.run.fingerprint = manager.fingerprint(f.session, '0.2.0-local-scope');
    f.store.saveSession(f.session);
    manager.restoreCached(f.session);
    expect(f.session.run.state).toBe('cancelled');
    expect(f.session.run.checkpoint?.pending).toBeUndefined();
    expect(called).toBe(0);
    manager.resume(f.session);
    await wait(() => !manager.isRunning(f.session.id));
    const result = f.store.session(f.session.id)!;
    expect(result.run?.state).toBe('complete');
    expect(result.run?.id).toBe('paused');
    expect(result.run?.result.summary).toBe('Preserve review');
    expect(called).toBe(1);
    expect(result.history).toBeUndefined();
  });
  it('keeps a message posted through a reloaded session when cancellation commits, then resumes that request', async () => {
    const f = await setup();
    let calls = 0,
      started = false;
    const provider = {
      id: 'conversation',
      async analyze(input: AnalysisInput, signal: AbortSignal) {
        calls++;
        if (calls === 1) {
          input.continuation!.checkpoint.threadId = 'paused-thread';
          input.continuation!.save();
          started = true;
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }),
          );
        }
        expect(input.continuation!.checkpoint.threadId).toBe('paused-thread');
        expect(input.userMessages).toEqual(['Учитывай только публичное API']);
        return { ...emptyModelResult(), summary: 'Разбор с уточнением' };
      },
    };
    const manager = new AnalysisManager(f.store, provider);
    cleanup.push(() => manager.stopAll());
    manager.start(f.session);
    await wait(() => started);
    manager.addMessage(f.store.session('chat')!, 'Учитывай только публичное API');
    await wait(() => !manager.isRunning('chat'));
    const stopped = f.store.session('chat')!;
    expect(stopped.run?.state).toBe('cancelled');
    expect(stopped.run?.messages?.[0].text).toContain('публичное API');
    const next = new AnalysisManager(f.store, provider);
    cleanup.push(() => next.stopAll());
    next.resume(stopped);
    await wait(() => !next.isRunning('chat'));
    expect(f.store.session('chat')?.run?.state).toBe('complete');
    expect(calls).toBe(2);
  });
});
