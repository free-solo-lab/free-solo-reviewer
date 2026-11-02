import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createApp, defaultLanguage } from '../server/app';
import { inAllLanguages, setLanguage, startsLike, t } from '../shared/i18n';
import { ru } from '../shared/locales/ru';
import { renderPrompt } from '../shared/prompt-templates';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  setLanguage('ru');
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

describe('interface languages', () => {
  it('keeps every placeholder and plural form in the Russian catalog', () => {
    for (const [key, value] of Object.entries(ru)) {
      const english = key.split('\u0004').at(-1)!;
      expect(placeholders(value), key).toEqual(placeholders(english));
      if (/^[^|]+\|[^|]+$/.test(english)) expect(value.split('|'), key).toHaveLength(3);
    }
  });
  it('keeps Russian text out of the source: English is written in code, translations in catalogs', async () => {
    // Saved logs of older runs are recognized by their Russian wording.
    const allowed = ['shared/locales/ru.ts', 'shared/i18n.ts', 'server/analysis-statistics.ts'];
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(tsx?|css|html)$/.test(entry.name)) {
          const file = relative(process.cwd(), path);
          if (!allowed.includes(file) && /[А-Яа-яЁё]/.test(await readFile(path, 'utf8')))
            offenders.push(file);
        }
      }
    };
    for (const dir of ['web', 'shared', 'server', 'desktop', 'build']) await walk(dir);
    expect(offenders).toEqual([]);
  });
  it('translates messages and recognizes text saved in any language', () => {
    setLanguage('en');
    expect(t('Session not found.')).toBe('Session not found.');
    expect(t('Analysis error: {0}', 'boom')).toBe('Analysis error: boom');
    expect(startsLike('Codex/анализ: тайм-аут', 'Codex/analysis: {0}')).toBe(true);
    expect(startsLike('Codex/analysis: timeout', 'Codex/analysis: {0}')).toBe(true);
    expect(inAllLanguages('Before and after')).toEqual(['Before and after', 'До и после']);
    setLanguage('ru');
    expect(t('Analysis error: {0}', 'сбой')).toBe('Ошибка анализа: сбой');
  });
  it('tells Codex to write in the chosen language', () => {
    setLanguage('en');
    expect(renderPrompt('tests', { tests: 'T1' })).toContain('short title in English');
    setLanguage('ru');
    expect(renderPrompt('tests', { tests: 'T1' })).toContain('short title in Russian');
  });
  it('defaults to REVIEW_LANGUAGE, then the system locale, then English', () => {
    expect(defaultLanguage({ REVIEW_LANGUAGE: 'ru', LANG: 'en_US.UTF-8' })).toBe('ru');
    expect(defaultLanguage({ LANG: 'ru_RU.UTF-8' })).toBe('ru');
    expect(defaultLanguage({ LANG: 'de_DE.UTF-8' })).toBe('en');
  });
  it('switches the language for the interface and the server messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-language-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { app, store } = createApp({ dataDir: join(root, 'data') });
    cleanup.push(() => app.close());
    const set = (language: string) =>
      app.inject({ method: 'PUT', url: '/api/settings/language', payload: { language } });
    expect((await set('de')).statusCode).toBe(400);
    expect((await set('en')).json()).toMatchObject({
      language: 'en',
      languages: [
        { id: 'en', label: 'English' },
        { id: 'ru', label: 'Русский' },
      ],
    });
    expect(store.language()).toBe('en');
    const missing = () => app.inject({ method: 'GET', url: '/api/sessions/unknown' });
    expect((await missing()).json().error).toBe('Session not found.');
    await set('ru');
    expect((await missing()).json().error).toBe('Сессия не найдена.');
  });
});
