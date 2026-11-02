import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { createApp } from '../server/app';
import {
  AnalysisMeasurements,
  backfillStatistics,
  legacyStatistic,
} from '../server/analysis-statistics';
import { elapsedMs, statisticSummary, statisticUsage } from '../shared/analysis-statistics';
import { emptyModelResult, type AnalysisRun, type ReviewSession } from '../shared/model';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-statistics-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'review.sqlite'));
  cleanup.push(() => store.close());
  const run: AnalysisRun = {
    id: 'run',
    sessionId: 's',
    version: 'test',
    fingerprint: 'f',
    startedAt: '2026-10-25T00:00:00Z',
    state: 'running',
    events: [],
    result: { ...emptyModelResult(), indexes: [], contracts: [] },
  };
  const session: ReviewSession = {
    id: 's',
    title: 'Review',
    createdAt: run.startedAt,
    snapshots: [],
    run,
  };
  return { root, store, run, session };
}
it('records parallel request costs separately but counts stage wall time once and starts a fresh continuation attempt', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-25T00:00:00Z');
  const stats = new AnalysisMeasurements(f.store);
  stats.start(f.session, 'fake');
  const first = stats.request('s', 'changes', 5);
  const second = stats.request('s', 'changes', 2);
  stats.usage('s', first, { input: 100, cached: 60, output: 20 });
  stats.usage('s', second, { input: 200, cached: 100, output: 10 });
  vi.setSystemTime('2026-10-25T00:00:10Z');
  stats.finishRequest('s', first);
  stats.finishRequest('s', second);
  f.run.state = 'partial';
  stats.finish(f.session);
  const record = f.store.analysisStatistics()[0];
  expect(statisticUsage(record)).toEqual({ input: 300, cached: 160, output: 30 });
  expect(record.requests).toHaveLength(2);
  expect(
    elapsedMs(
      record.stages.find((s) => s.stage === 'changes')!.startedAt,
      record.stages.find((s) => s.stage === 'changes')!.finishedAt,
    ),
  ).toBe(10000);
  expect(statisticSummary(record).durationMs).toBe(10000);
  vi.setSystemTime('2026-10-25T01:00:00Z');
  f.run.state = 'running';
  stats.start(f.session, 'fake');
  const resumed = stats.request('s', 'sql', 1);
  vi.setSystemTime('2026-10-25T01:00:05Z');
  stats.finishRequest('s', resumed, new Error('Rate limit'));
  f.run.state = 'partial';
  stats.finish(f.session);
  const records = f.store.analysisStatistics();
  expect(records).toHaveLength(2);
  expect(statisticSummary(records[0]).durationMs).toBe(5000);
  expect(records[0].requests[0].status).toBe('failed');
  expect(statisticUsage(records[0])).toBeNull();
});
it('restores available historical counters once without inventing per-request data or spending tokens on cache hits', async () => {
  const f = await fixture();
  f.run.state = 'complete';
  f.run.finishedAt = '2026-10-25T00:02:00Z';
  f.run.events = [
    { seq: 1, at: '2026-10-25T00:00:10Z', message: 'Начинаем основной разбор' },
    {
      seq: 2,
      at: '2026-10-25T00:01:00Z',
      kind: 'usage',
      message: 'Токены этапа: вход 100, из кэша 80, выход 10.',
    },
    { seq: 3, at: '2026-10-25T00:01:10Z', message: 'Codex дополняет SQL.' },
    {
      seq: 4,
      at: '2026-10-25T00:02:00Z',
      kind: 'usage',
      message: 'Токены этапа: вход 200, из кэша 120, выход 30.',
    },
  ];
  f.store.saveSession(f.session);
  backfillStatistics(f.store);
  backfillStatistics(f.store);
  const records = f.store.analysisStatistics();
  expect(records).toHaveLength(1);
  expect(statisticUsage(records[0])).toEqual({ input: 300, cached: 200, output: 40 });
  expect(records[0].stages.find((s) => s.stage === 'sql')?.usage?.input).toBe(200);
  expect(records[0].requests).toEqual([]);
  expect(statisticSummary(records[0]).requestCount).toBeNull();
  const cached = legacyStatistic(f.session, {
    ...f.run,
    cacheRestored: true,
    events: [],
    usage: { input: 999, cached: 800, output: 100 },
  });
  expect(statisticUsage(cached)).toEqual({ input: 0, cached: 0, output: 0 });
});
it('serves compact history and details after restart and marks interrupted requests as partial', async () => {
  const f = await fixture();
  f.store.saveSession(f.session);
  const measurements = new AnalysisMeasurements(f.store);
  measurements.start(f.session, 'fake');
  measurements.request('s', 'review');
  const app = createApp({ dataDir: f.root });
  cleanup.push(() => app.app.close());
  const response = await app.app.inject({ method: 'GET', url: '/api/settings/statistics' });
  expect(response.statusCode).toBe(200);
  const [record] = response.json();
  expect(record.status).toBe('partial');
  expect(record).not.toHaveProperty('requests');
  const detail = (
    await app.app.inject({
      method: 'GET',
      url: '/api/settings/statistics/' + encodeURIComponent(record.id),
    })
  ).json();
  expect(detail.requests[0].status).toBe('partial');
  expect(detail).not.toHaveProperty('events');
  expect(
    (await app.app.inject({ method: 'GET', url: '/api/settings/statistics/missing' })).statusCode,
  ).toBe(404);
});
