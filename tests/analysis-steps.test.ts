import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../server/app';
import type { AnalysisInput } from '../server/provider';
import { stepOfPrompt } from '../shared/analysis-steps';
import type { ReviewSession } from '../shared/model';
import { fixture, FixtureProvider } from './fixtures';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Analysis did not finish');
}

describe('optional analysis steps', () => {
  it('ties templates to the stage that uses them and keeps the main review always on', () => {
    expect(stepOfPrompt('tests')?.id).toBe('tests');
    expect(stepOfPrompt('reuseCards')?.id).toBe('changes');
    expect(stepOfPrompt('review')).toBeUndefined();
    expect(stepOfPrompt('analysis')).toBeUndefined();
  });
  it('skips switched-off stages, finishes the review and does not cache it as complete', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const inputs: AnalysisInput[] = [];
    const delegate = new FixtureProvider();
    let described = 0;
    const { app, store } = createApp({
      dataDir: join(f.root, 'app'),
      github: f.github,
      provider: {
        id: 'steps-fixture',
        analyze: (input, signal, progress) => {
          inputs.push(input);
          return delegate.analyze(input, signal, progress);
        },
        describeChanges: async () => {
          described++;
          return [];
        },
      },
    });
    cleanup.push(() => app.close());
    store.saveRepository(f.repo);
    const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
      app.inject({ method, url, payload: payload as object });
    expect(
      (await request('PUT', '/api/settings/steps', { disabled: ['unknown'] })).statusCode,
    ).toBe(400);
    const saved = await request('PUT', '/api/settings/steps', {
      disabled: ['changes', 'scenarios', 'sql', 'tests', 'tests'],
    });
    expect(saved.json()).toEqual({
      disabled: ['changes', 'scenarios', 'sql', 'tests'],
      onDemand: [],
    });
    const session = (
      await request('POST', '/api/sessions', {
        title: 'Steps',
        repositories: [{ repoId: f.repo.id, prNumber: 12 }],
      })
    ).json<ReviewSession>();
    await request('POST', `/api/sessions/${session.id}/analyze`, {});
    await waitFor(() => store.session(session.id)?.run?.state !== 'running');
    const run = store.session(session.id)!.run!;
    expect(run.state).toBe('complete');
    expect(run.skippedSteps).toEqual(['changes', 'scenarios', 'sql', 'tests']);
    expect(run.events.map((event) => event.message).join('\n')).toContain(
      'Этап «Описание тестов» отключён в настройках',
    );
    // Only the main review asked the model; no change cards, SQL, test or scenario turns.
    expect(described).toBe(0);
    expect(
      inputs.every((input) => !input.sqlOnly && !input.testsOnly && !input.scenariosOnly),
    ).toBe(true);
    expect(store.analysisResult(run.fingerprint)).toBeUndefined();
  });
});
