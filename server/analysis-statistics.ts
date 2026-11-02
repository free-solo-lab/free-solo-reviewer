import { randomUUID } from 'node:crypto';
import type { AnalysisRun, ProgressEvent, ReviewSession } from '../shared/model.js';
import {
  addTokens,
  emptyTokens,
  type AnalysisRequestMetric,
  type AnalysisStage,
  type AnalysisStatistic,
  type TokenUsage,
} from '../shared/analysis-statistics.js';
import type { Store } from './store.js';
import { errorMessage } from '../shared/errors.js';
import { t } from '../shared/i18n.js';

/** Separate from review artifacts: historical costs survive a refresh or deleting a review. */
export class AnalysisMeasurements {
  private active = new Map<string, AnalysisStatistic>();
  constructor(private store: Store) {}
  start(session: ReviewSession, provider: string) {
    const run = session.run!;
    const metric: AnalysisStatistic = {
      continued: this.store.analysisStatistics().some((stat) => stat.runId === run.id),
      id: randomUUID(),
      runId: run.id,
      sessionId: session.id,
      title: session.title,
      startedAt: new Date().toISOString(),
      status: 'running',
      provider,
      model: process.env.REVIEW_CODEX_MODEL ?? 'default',
      approximate: false,
      stages: [],
      requests: [],
    };
    this.active.set(session.id, metric);
    this.stage(session.id, run.checkpoint?.stage ?? 'prepare');
  }
  stage(sessionId: string, stage: AnalysisStage) {
    const stat = this.active.get(sessionId);
    if (!stat) return;
    // Card descriptions run in parallel; their wall-clock interval is counted once.
    if (stat.requests.some((r) => r.stage === 'changes' && r.status === 'running'))
      stage = 'changes';
    const previous = stat.stages.at(-1);
    if (previous?.stage === stage) return;
    const now = new Date().toISOString();
    if (previous) previous.finishedAt = now;
    stat.stages.push({ stage, startedAt: now });
    this.store.saveAnalysisStatistic(stat);
  }
  request(sessionId: string, stage: AnalysisStage, targets?: number) {
    const stat = this.active.get(sessionId);
    if (!stat) return;
    this.stage(sessionId, stage);
    const request: AnalysisRequestMetric = {
      id: randomUUID(),
      stage,
      targets,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    stat.requests.push(request);
    this.store.saveAnalysisStatistic(stat);
    return request;
  }
  usage(sessionId: string, request: AnalysisRequestMetric | undefined, usage: TokenUsage) {
    const stat = this.active.get(sessionId);
    if (!stat || !request) return;
    request.usage = addTokens(request.usage ?? emptyTokens(), usage);
    this.store.saveAnalysisStatistic(stat);
  }
  finishRequest(
    sessionId: string,
    request: AnalysisRequestMetric | undefined,
    error?: unknown,
    cancelled = false,
  ) {
    const stat = this.active.get(sessionId);
    if (!stat || !request) return;
    request.finishedAt = new Date().toISOString();
    request.status = error ? (cancelled ? 'cancelled' : 'failed') : 'complete';
    if (error) request.error = errorMessage(error);
    this.store.saveAnalysisStatistic(stat);
  }
  finish(session: ReviewSession) {
    const stat = this.active.get(session.id);
    if (!stat) return;
    stat.finishedAt = new Date().toISOString();
    stat.status = session.run?.state === 'running' ? 'partial' : (session.run?.state ?? 'partial');
    for (const request of stat.requests)
      if (request.status === 'running') {
        request.status = stat.status === 'cancelled' ? 'cancelled' : 'partial';
        request.finishedAt = stat.finishedAt;
      }
    const last = stat.stages.at(-1);
    if (last) last.finishedAt = stat.finishedAt;
    this.store.saveAnalysisStatistic(stat);
    this.active.delete(session.id);
  }
}
/** Stage of a logged progress message; logs keep the language they were written in. */
function stageFromEvent(event: ProgressEvent, previous: AnalysisStage): AnalysisStage {
  if (event.kind && event.kind !== 'progress') return previous;
  const text = event.message;
  if (/Продолжаем анализ с этапа|Continuing the analysis from the/.test(text)) {
    if (/тесты|tests/.test(text)) return 'tests';
    if (/SQL/.test(text)) return 'sql';
    if (/сценарии|scenarios/.test(text)) return 'scenarios';
    if (/основной разбор|main review/.test(text)) return 'review';
    return 'prepare';
  }
  if (/Описываем изменения|Describing changes/.test(text)) return 'changes';
  if (
    /Начинаем основной разбор|читает локальные изменения|Starting the main review|reading local changes/.test(
      text,
    )
  )
    return 'review';
  if (
    /дополняет недостающие сценарии|полноту сценариев|completing missing scenarios|scenario catalog/.test(
      text,
    )
  )
    return 'scenarios';
  if (
    /Разбираем изменения базы|Codex дополняет SQL|Codex формирует SQL|Analyzing database changes|Codex is (?:completing|generating) SQL/.test(
      text,
    )
  )
    return 'sql';
  if (/Codex.*(?:тесты|изменённых тестов|test)/.test(text)) return 'tests';
  return previous;
}
export function legacyStatistic(
  session: Pick<ReviewSession, 'id' | 'title'>,
  run: AnalysisRun,
): AnalysisStatistic {
  const stat: AnalysisStatistic = {
    id: `legacy:${run.id}`,
    runId: run.id,
    sessionId: session.id,
    title: session.title,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.state,
    approximate: true,
    cacheRestored: run.cacheRestored,
    stages: [],
    requests: [],
  };
  let stage: AnalysisStage = 'prepare';
  for (const event of run.events) {
    const next = stageFromEvent(event, stage);
    if (!stat.stages.length || next !== stage) {
      const last = stat.stages.at(-1);
      if (last) last.finishedAt = event.at;
      stat.stages.push({ stage: next, startedAt: stat.stages.length ? event.at : run.startedAt });
    }
    stage = next;
    if (event.kind === 'usage' || /Токены этапа:|Stage tokens:/.test(event.message)) {
      const tokens = /(?:вход|input) (\d+), (?:из кэша|cached) (\d+), (?:выход|output) (\d+)/.exec(
        event.message,
      );
      if (tokens) {
        const current = stat.stages.at(-1)!;
        current.usage = addTokens(current.usage ?? emptyTokens(), {
          input: +tokens[1],
          cached: +tokens[2],
          output: +tokens[3],
        });
      }
    }
  }
  if (!stat.stages.length) stat.stages.push({ stage: 'review', startedAt: run.startedAt });
  stat.stages.at(-1)!.finishedAt = run.finishedAt;
  if (!stat.cacheRestored && !stat.stages.some((s) => s.usage) && run.usage)
    stat.stages[0].usage = run.usage;
  return stat;
}
export function backfillStatistics(store: Store) {
  const sessions = store.sessions();
  for (const stat of store.analysisStatistics()) {
    if (
      stat.status !== 'running' ||
      sessions.some(
        (s) => s.id === stat.sessionId && s.run?.state === 'running' && s.run.id === stat.runId,
      )
    )
      continue;
    stat.finishedAt = stat.updatedAt ?? stat.startedAt;
    stat.status = 'partial';
    for (const request of stat.requests)
      if (request.status === 'running') {
        request.status = 'partial';
        request.finishedAt = stat.finishedAt;
        request.error = t('The request was interrupted by an app restart.');
      }
    const last = stat.stages.at(-1);
    if (last && !last.finishedAt) last.finishedAt = stat.finishedAt;
    store.saveAnalysisStatistic(stat);
  }
  const recorded = new Set(store.analysisStatistics().map((stat) => stat.runId));
  for (const session of sessions) {
    for (const run of [
      ...(session.history ?? []).map((h) => h.run),
      ...(session.run ? [session.run] : []),
    ]) {
      if (recorded.has(run.id) || run.state === 'running') continue;
      store.saveAnalysisStatistic(legacyStatistic(session, run));
      recorded.add(run.id);
    }
  }
}
