import type { ReviewReaction } from './reactions.js';
import { z } from 'zod';

export const ANALYZER_VERSION = '0.1.0';
export const SQL_ANALYSIS_VERSION = 'codex-sql-1';
export const TEST_ANALYSIS_VERSION = 'codex-tests-1';
export const sideSchema = z.enum(['base', 'head']);
export const confidenceSchema = z.enum(['extracted', 'inferred', 'unknown']);
export const evidenceSchema = z.object({
  repoId: z.string(),
  side: sideSchema,
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
const claim = {
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  confidence: confidenceSchema,
  evidence: z.array(evidenceSchema),
};
export const findingSchema = z.object({
  ...claim,
  severity: z.enum(['high', 'medium', 'low', 'info']),
});
export const scenarioSchema = z.object({
  ...claim,
  services: z.array(z.string()),
  steps: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      label: z.string(),
      kind: z.enum(['call', 'return', 'event', 'database']),
      change: z.enum(['added', 'removed', 'modified', 'unchanged', 'unknown']),
      branch: z.string(),
      confidence: confidenceSchema,
      evidence: z.array(evidenceSchema),
    }),
  ),
});
export const databaseSchema = z.object({
  ...claim,
  kind: z.enum(['migration', 'sql', 'jooq', 'orm']),
  dialect: z.string(),
  sql: z.string(),
  tables: z.array(z.string()),
  unknowns: z.array(z.string()),
  query: z
    .object({
      method: z.string(),
      framework: z.enum(['jooq', 'hibernate', 'jdbc', 'unknown']),
      evidence: evidenceSchema,
      parameters: z.array(
        z.object({ position: z.number().int().positive(), expression: z.string() }),
      ),
    })
    .nullable()
    .optional(),
});
export const transactionSchema = z.object({
  ...claim,
  propagation: z.string(),
  rollback: z.string(),
  operations: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(['database', 'remote', 'method', 'retry', 'catch', 'compensation']),
      risk: z.string(),
      evidence: z.array(evidenceSchema),
    }),
  ),
  unknowns: z.array(z.string()),
});
export const reviewTestSchema = z.object({
  ...claim,
  method: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      label: z.string(),
      kind: z.enum(['setup', 'mock', 'call', 'assertion']),
      evidence: z.array(evidenceSchema),
      data: z.array(
        z.object({
          label: z.string(),
          type: z.string(),
          value: z.string(),
          role: z.enum(['input', 'output', 'mock', 'expected', 'fixture']),
          evidence: z.array(evidenceSchema),
        }),
      ),
    }),
  ),
});
export type ReviewTest = z.infer<typeof reviewTestSchema>;
export const modelResultSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
  scenarios: z.array(scenarioSchema),
  database: z.array(databaseSchema),
  transactions: z.array(transactionSchema),
  gaps: z.array(z.string()),
  tests: z.array(reviewTestSchema).optional(),
  followUp: z
    .object({
      summary: z.string(),
      items: z.array(
        z.object({
          previousId: z.string(),
          status: z.enum(['fixed', 'still_present', 'answered', 'changed', 'unknown']),
          summary: z.string(),
          evidence: z.array(evidenceSchema),
        }),
      ),
    })
    .optional(),
});
export type ModelResult = z.infer<typeof modelResultSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type DatabaseOperation = z.infer<typeof databaseSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type Side = z.infer<typeof sideSchema>;
export type ReviewAction = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export interface Repository {
  id: string;
  path: string;
  name: string;
  slug: string;
}
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
  headRefName: string;
  body: string;
  author: { login: string };
}
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: string;
  patch: string;
  addedLines: number[];
  removedLines: number[];
}
export interface Snapshot {
  id: string;
  repoId: string;
  repoName: string;
  slug: string;
  pr: PullRequest | null;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  files: ChangedFile[];
  baseFiles: string[];
  headFiles: string[];
  baseDir: string;
  headDir: string;
}
export interface IndexedMethod {
  name: string;
  signature: string;
  annotations: string[];
  calls: string[];
  evidence: Evidence;
  callSites?: IndexedCall[];
  programmaticTransactions?: ProgrammaticTransaction[];
}
export interface IndexedCall {
  name: string;
  receiver: string;
  evidence: Evidence;
  transactionIds: string[];
  database: boolean;
}
export interface ProgrammaticTransaction {
  id: string;
  api: string;
  evidence: Evidence;
  callback: boolean;
  asynchronous: boolean;
  nested: boolean;
}
export interface SourceIndex {
  version?: string;
  repoId: string;
  side: Side;
  methods: IndexedMethod[];
  errors: string[];
  filesIndexed: number;
}
export interface Contract {
  id: string;
  repoId: string;
  path: string;
  title: string;
  reconstructed: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changes: string[];
  evidence: Evidence[];
  error?: string;
}
export interface AnalysisResult extends ModelResult {
  testAnalysisVersion?: string;
  sqlAnalysisVersion?: string;
  contracts: Contract[];
  indexes: SourceIndex[];
}
export interface AnalysisRun {
  id: string;
  sessionId: string;
  version: string;
  fingerprint: string;
  state: 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result: AnalysisResult;
  events: ProgressEvent[];
  previousReviewId?: string;
  cacheRestored?: boolean;
  sqlBaseState?: 'complete' | 'partial';
  testsBaseState?: 'complete' | 'partial';
  scenariosBaseState?: 'complete' | 'partial';
  error?: string;
}
export interface ProgressEvent {
  seq: number;
  at: string;
  message: string;
}
export interface ReviewSession {
  id: string;
  title: string;
  createdAt: string;
  snapshots: Snapshot[];
  run: AnalysisRun | null;
  history?: ReviewRevision[];
  update?: ReviewUpdate;
  discussion?: ReviewDiscussion[];
  threadDiscussion?: ReviewDiscussion[];
  refreshWarnings?: string[];
}
export interface ReviewRevision {
  id: string;
  savedAt: string;
  snapshots: Snapshot[];
  run: AnalysisRun;
  drafts: ReviewDraft[];
}
export interface ReviewDiscussion {
  reactions?: ReviewReaction[];
  id: string;
  repoId: string;
  body: string;
  author: string;
  url: string;
  at: string;
  updatedAt: string;
  replyTo?: string;
  reviewId?: number;
  location?: {
    path: string;
    side: Side;
    line: number | null;
    startLine?: number | null;
    originalLine?: number | null;
    originalStartLine?: number | null;
  };
  commitId?: string;
  originalCommitId?: string;
}
export interface ReviewUpdate {
  id: string;
  at: string;
  previousReviewId: string;
  changes: { repoId: string; fromSha: string; toSha: string; files: ChangedFile[] }[];
  discussion: ReviewDiscussion[];
  gaps: string[];
}
export interface DraftComment {
  id: string;
  body: string;
  evidence: Evidence | null;
  selected: boolean;
}
export interface Submission {
  id: number;
  url: string;
  at: string;
}
export interface ReviewDraft {
  sessionId: string;
  snapshotId: string;
  headSha: string;
  body: string;
  action: ReviewAction;
  comments: DraftComment[];
  state: 'draft' | 'submitting' | 'uncertain' | 'submitted';
  attempt: { marker: string; at: string; payload: unknown } | null;
  submission: Submission | null;
}
export const emptyModelResult = (): ModelResult => ({
  summary: '',
  findings: [],
  scenarios: [],
  database: [],
  transactions: [],
  gaps: [],
});
