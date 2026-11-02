import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import {
  promptSettings,
  promptTemplates,
  renderPrompt,
  validatePrompt,
} from '../shared/prompt-templates';
import { localAnalysisPrompt } from '../server/analysis-workspace';
import { cardsPrompt } from '../server/change-cards';
import { testTitlesPrompt } from '../server/provider';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('editable analysis prompts', () => {
  it('substitutes dynamic data exactly once and requires the declared variables', () => {
    const custom = '{{tests}}\nDescribe briefly';
    expect(renderPrompt('tests', { tests: 'untrusted {{stage}} $&' }, { tests: custom })).toBe(
      'untrusted {{stage}} $&\nDescribe briefly',
    );
    expect(() => validatePrompt('tests', custom)).not.toThrow();
    expect(() => validatePrompt('tests', 'Describe briefly')).toThrow('{{tests}}');
    expect(() => validatePrompt('tests', '{{tests}} {{unknown}}')).toThrow('Неизвестные');
    expect(() => validatePrompt('review', '')).toThrow('пустым');
  });
  it('uses custom templates in stage requests, card descriptions and test descriptions', () => {
    const input = { snapshots: [], indexes: [] };
    const settings = promptSettings({});
    const overrides = Object.fromEntries(
      settings.map((p) => [p.id, p.template + '\nCUSTOM:' + p.id]),
    );
    expect(localAnalysisPrompt(input, [], overrides)).toContain('CUSTOM:review');
    expect(localAnalysisPrompt({ ...input, sqlOnly: true }, [], overrides)).toContain(
      'CUSTOM:database',
    );
    expect(localAnalysisPrompt({ ...input, scenariosOnly: [] }, [], overrides)).toContain(
      'CUSTOM:scenarios',
    );
    expect(localAnalysisPrompt(input, [], overrides)).toContain('CUSTOM:analysis');
    expect(cardsPrompt([], overrides)).toContain('CUSTOM:changes');
    expect(testTitlesPrompt(['T1 sample'], overrides)).toContain('T1 sample');
    expect(testTitlesPrompt([], overrides)).toContain('CUSTOM:tests');
  });
  it('persists edits across server restarts and restores the default without changing other templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-settings-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let current = createApp({ dataDir: root });
    cleanup.push(() => current.app.close());
    const request = (method: 'GET' | 'PUT', path = '', payload?: object) =>
      current.app.inject({ method, url: '/api/settings/prompts' + path, payload });
    const defaults = (await request('GET')).json<ReturnType<typeof promptSettings>>();
    expect(defaults.length).toBe(promptTemplates.length);
    expect(defaults.every((p) => p.description && p.step && !p.customized)).toBe(true);
    expect((await request('PUT', '/tests', { template: 'Custom {{tests}}' })).json()).toMatchObject(
      { customized: true, template: 'Custom {{tests}}' },
    );
    await current.app.close();
    current = createApp({ dataDir: root });
    const restored = (await request('GET')).json<ReturnType<typeof promptSettings>>();
    expect(restored.find((p) => p.id === 'tests')?.template).toBe('Custom {{tests}}');
    const invalid = await request('PUT', '/tests', { template: 'Missing variable' });
    expect(invalid.statusCode).toBe(400);
    expect(
      (await request('GET')).json().find((p: { id: string }) => p.id === 'tests').template,
    ).toBe('Custom {{tests}}');
    expect((await request('PUT', '/missing', { template: 'Bad' })).statusCode).toBe(404);
    expect((await request('PUT', '/tests', { template: null })).json()).toMatchObject({
      customized: false,
      template: defaults.find((p) => p.id === 'tests')!.template,
    });
    expect(current.store.promptOverrides()).toEqual({});
    // Editing settings cannot create or launch an analysis.
    expect(current.store.sessions()).toEqual([]);
  });
});
