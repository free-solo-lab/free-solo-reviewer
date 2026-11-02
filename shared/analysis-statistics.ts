import { t } from './i18n.js';
export type AnalysisStage =
  'prepare' | 'changes' | 'review' | 'scenarios' | 'sql' | 'tests' | 'done';
export const analysisStageNames: Record<AnalysisStage, string> = {
  prepare: t('Preparation'),
  changes: t('Change descriptions'),
  review: t('Main review'),
  scenarios: t('Scenario completion'),
  sql: t('SQL and database'),
  tests: t('Tests'),
  done: t('Finishing'),
};
export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}
export type AnalysisStatus = 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
export interface AnalysisRequestMetric {
  id: string;
  stage: AnalysisStage;
  startedAt: string;
  finishedAt?: string;
  status: AnalysisStatus;
  targets?: number;
  usage?: TokenUsage;
  error?: string;
}
export interface AnalysisStageMetric {
  stage: AnalysisStage;
  startedAt: string;
  finishedAt?: string;
  usage?: TokenUsage;
}
export interface AnalysisStatistic {
  continued?: boolean;
  updatedAt?: string;
  id: string;
  runId: string;
  sessionId: string;
  title: string;
  startedAt: string;
  finishedAt?: string;
  status: AnalysisStatus;
  provider?: string;
  model?: string;
  approximate: boolean;
  cacheRestored?: boolean;
  stages: AnalysisStageMetric[];
  requests: AnalysisRequestMetric[];
}
export interface AnalysisStatisticSummary extends Omit<AnalysisStatistic, 'requests' | 'stages'> {
  requestCount: number | null;
  usage: TokenUsage | null;
  durationMs: number;
}
export const elapsedMs = (start: string, end?: string, now = Date.now()) =>
  Math.max(0, (end ? Date.parse(end) : now) - Date.parse(start)) || 0;
export const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cached: a.cached + b.cached,
  output: a.output + b.output,
});
export const emptyTokens = (): TokenUsage => ({ input: 0, cached: 0, output: 0 });
export function statisticUsage(stat: AnalysisStatistic): TokenUsage | null {
  const values = stat.approximate
    ? stat.stages.flatMap((s) => (s.usage ? [s.usage] : []))
    : stat.requests.flatMap((r) => (r.usage ? [r.usage] : []));
  if (values.length) return values.reduce(addTokens, emptyTokens());
  return stat.cacheRestored || (!stat.approximate && !stat.requests.length) ? emptyTokens() : null;
}
export function statisticSummary(stat: AnalysisStatistic): AnalysisStatisticSummary {
  const { requests, stages: _stages, ...rest } = stat;
  return {
    ...rest,
    requestCount: stat.approximate ? null : requests.length,
    usage: statisticUsage(stat),
    durationMs: elapsedMs(stat.startedAt, stat.finishedAt),
  };
}
