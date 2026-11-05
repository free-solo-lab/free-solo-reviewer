import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { command } from '../server/process';
import { desktopLogEntries, SystemLog, systemLog } from '../server/system-log';
import { formatLogEntries, redactSecrets } from '../shared/system-log';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-logs-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
};

describe('system log', () => {
  it('keeps the latest entries, notifies subscribers and hides secrets', () => {
    const log = new SystemLog();
    const seen: string[] = [];
    const stop = log.subscribe((entry) => seen.push(entry.message));
    log.error('command', 'gh auth token ghp_abcdefghijklmnopqrstuvwxyz0123', 'password=hunter22');
    stop();
    log.info('process', 'after');
    expect(seen).toEqual(['gh auth token [secret]']);
    expect(log.list()[0].details).toBe('password=[secret]');
    expect(log.list(1).map((entry) => entry.message)).toEqual(['after']);
    for (let i = 0; i < 2100; i++) log.info('process', `n${i}`);
    expect(log.list()).toHaveLength(2000);
    expect(log.list().at(-1)!.message).toBe('n2099');
    expect(redactSecrets('https://user:pa55@github.com/x Bearer abcdefghijklmnop')).toBe(
      'https://user:[secret]@github.com/x Bearer [secret]',
    );
    expect(formatLogEntries(log.list().slice(-1))).toMatch(/^\S+ INFO \[process\] n2099$/);
  });
  it('records failed commands with their exit code and error output', async () => {
    const before = systemLog.list().at(-1)?.seq ?? 0;
    await expect(
      command('node', ['-e', 'console.error("boom"); process.exit(3)']),
    ).rejects.toThrow();
    const entry = systemLog.list(before).find((item) => item.source === 'command');
    expect(entry).toMatchObject({ level: 'warn', details: 'boom' });
    expect(entry!.message).toMatch(/^node -e .* → exit 3 \(\d+ ms\)$/);
  });
  it('reads the desktop journal and marks its failures', async () => {
    const root = await temporary();
    await writeFile(
      join(root, 'desktop.log'),
      [
        JSON.stringify({
          version: '0.2.1',
          timestamp: '2026-11-05T10:00:00.000Z',
          stage: 'launch',
        }),
        'not json',
        JSON.stringify({
          timestamp: '2026-11-05T10:00:01.000Z',
          stage: 'server-start-failed',
          error: 'EADDRINUSE',
        }),
      ].join('\n'),
    );
    const entries = await desktopLogEntries(root);
    expect(entries.map((entry) => [entry.level, entry.message, entry.details])).toEqual([
      ['info', 'launch · v0.2.1', undefined],
      ['error', 'server-start-failed', 'error: EADDRINUSE'],
    ]);
    expect(await desktopLogEntries(join(root, 'missing'))).toEqual([]);
  });
  it('serves the journal, logs API failures and accepts interface errors', async () => {
    const root = await temporary();
    const { app } = createApp({ dataDir: join(root, 'data') });
    cleanup.push(() => app.close());
    const before = systemLog.list().at(-1)?.seq ?? 0;
    expect(
      (await app.inject({ method: 'GET', url: '/api/sessions/unknown?path=x' })).statusCode,
    ).toBe(404);
    const client = await app.inject({
      method: 'POST',
      url: '/api/logs/client',
      payload: { message: 'Interface error: x is undefined', details: 'at App' },
    });
    expect(client.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/logs?after=${before}` });
    expect(after.json().entries.map((e: { source: string; message: string }) => e.source)).toEqual([
      'http',
      'client',
    ]);
    expect(after.json().entries[0].message).toMatch(/^GET \/api\/sessions\/unknown → 404: /);
    expect(
      (await app.inject({ method: 'POST', url: '/api/logs/client', payload: { message: '' } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/logs', payload: {} })).statusCode).toBe(
      200,
    );
    expect(systemLog.list()).toHaveLength(0);
  });
});
