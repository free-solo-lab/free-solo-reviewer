import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AnalysisModelCheckpoint, Snapshot } from '../shared/model';
import type { PromptOverrides } from '../shared/prompt-templates';
import { promptTemplates } from '../shared/prompt-templates';

const sdk = vi.hoisted(() => ({ prompts: [] as string[], answer: {} as object }));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return this.resumeThread();
    }
    resumeThread() {
      return {
        runStreamed: async (prompt: string) => {
          sdk.prompts.push(prompt);
          async function* events() {
            yield { type: 'thread.started', thread_id: 'fake-thread' };
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', text: JSON.stringify(sdk.answer) },
            };
          }
          return { events: events() };
        },
      };
    }
  },
}));
import { CodexProvider } from '../server/provider';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  sdk.prompts = [];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const defaults = Object.fromEntries(promptTemplates.map((p) => [p.id, p.template]));
it('sends saved prompts to Codex and pins them while an interrupted stage is resumed', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'fake-key-never-sent');
  const root = await mkdtemp(join(tmpdir(), 'review-prompt-sdk-'));
  roots.push(root);
  let overrides: PromptOverrides = {
    database: defaults.database + '\nFIRST_SQL',
    continuation: 'CONTINUE_SAVED',
  };
  const provider = new CodexProvider(() => overrides);
  const checkpoint: AnalysisModelCheckpoint = { key: 'sql', home: root };
  const input = {
    snapshots: [],
    indexes: [],
    sqlOnly: true,
    continuation: { checkpoint, save() {} },
  };
  sdk.answer = { summary: '', findings: [], scenarios: [], database: [], gaps: [], followUp: null };
  await provider.analyze(input, new AbortController().signal, () => {});
  expect(sdk.prompts[0]).toContain('FIRST_SQL');
  overrides = { database: defaults.database + '\nSECOND_SQL' };
  await provider.analyze(input, new AbortController().signal, () => {});
  expect(sdk.prompts[1]).toContain('FIRST_SQL');
  expect(sdk.prompts[1]).not.toContain('SECOND_SQL');
  expect(sdk.prompts[1]).toContain('CONTINUE_SAVED');
  const next = { ...input, continuation: { checkpoint: { key: 'next', home: root }, save() {} } };
  await provider.analyze(next, new AbortController().signal, () => {});
  expect(sdk.prompts[2]).toContain('SECOND_SQL');
});
it('uses customization for tool-less change cards and tests too', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'fake-key-never-sent');
  const root = await mkdtemp(join(tmpdir(), 'review-prompt-tests-'));
  roots.push(root);
  const provider = new CodexProvider(() => ({
    changes: 'CUSTOM_CARDS {{uiInstructions}} {{changes}}',
    tests: 'CUSTOM_TESTS {{tests}}',
  }));
  sdk.answer = { cards: [] };
  await provider.describeChanges([], new AbortController().signal);
  expect(sdk.prompts.at(-1)).toContain('CUSTOM_CARDS');
  const path = 'ExampleTest.java';
  await writeFile(
    join(root, path),
    'class ExampleTest {\n @Test void reads() { assertTrue(true); }\n}\n',
  );
  const evidence = { repoId: 'r', side: 'head' as const, path, startLine: 2, endLine: 2 };
  const target = {
    name: 'reads',
    signature: 'void reads()',
    annotations: ['@Test'],
    calls: [],
    evidence,
  };
  const snapshot = {
    slug: 'local/example',
    pr: null,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    id: 's',
    repoId: 'r',
    repoName: 'example',
    headDir: root,
    baseDir: root,
    headFiles: [path],
    baseFiles: [],
    files: [{ path, status: 'A', addedLines: [2], removedLines: [], patch: '' }],
  } as Snapshot;
  sdk.answer = { tests: [{ id: 'T1', title: 'Проверка', summary: 'Проверяет результат' }] };
  await provider.analyze(
    { snapshots: [snapshot], indexes: [], testsOnly: true, testTargets: [target] },
    new AbortController().signal,
    () => {},
  );
  expect(sdk.prompts.at(-1)).toContain('CUSTOM_TESTS');
  expect(sdk.prompts.at(-1)).toContain('assertTrue(true)');
});
