import type { ReviewReaction } from './reactions.js';
import { z } from 'zod';

export const ANALYZER_VERSION = '0.4.0-review-workflow';
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
      description: z.string().optional(),
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

/** Branch names of a repository, most recently changed first. */
export interface RepositoryBranches {
  /** The checked-out branch: the one a local review reads; null on a detached HEAD. */
  current: string | null;
  local: string[];
  remote: string[];
}
export interface Repository {
  defaultLocalBase?: string;
  id: string;
  path: string;
  name: string;
  slug: string;
  /** The `gh` account that acts on this repository; without it, the active `gh` account. */
  githubUser?: string;
}
/** GitHub accounts `gh` is logged in to on github.com. */
export interface GitHubAccounts {
  active: string | null;
  accounts: string[];
  /** Reviewer's current user: chosen in the app, otherwise the active `gh` account. */
  current?: string | null;
}
/** An open pull request that asks the current user, or one of their teams, for a review. */
export interface ReviewRequest {
  slug: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  draft: boolean;
  /** Requested from the user personally rather than through a team. */
  direct: boolean;
  /** The connected local repository with this remote, if any. */
  repoId?: string;
}
/** Adding a `gh` account from the app: the device code to confirm on github.com and the outcome. */
export type GitHubLoginState =
  | { state: 'idle' }
  | { state: 'waiting'; code: string; url: string }
  | { state: 'done'; login: string }
  | { state: 'failed'; error: string };
/** How the analysis reaches Codex: a saved `codex login`, or the server's OPENAI_API_KEY. */
export type CodexAuth = 'login' | 'api-key' | null;
export type CodexLoginState =
  | { state: 'idle' }
  | { state: 'waiting'; code: string; url: string }
  | { state: 'done' }
  | { state: 'failed'; error: string };
export const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
export interface PullRequest {
  state?: 'open' | 'closed' | 'merged';
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
  /** Reviewable source content, independent of commit parents and publication transport. */
  contentHash?: string;
  baseContentHash?: string;
  reviewLineage?: string;
  /** Unpublished working source attached to an existing PR. */
  working?: Snapshot['local'];
  /** Equivalent local checkout preserved across explicit publication. */
  workspaceHead?: string;
  /** Read-only comparison view: the underlying immutable snapshot, used by drafts. */
  reviewSnapshotId?: string;
  reviewBase?: { snapshotId: string; revisionId: string };
  local?: {
    branchName?: string;
    baseRef: string;
    baseCommit: string;
    headCommit: string;
    fingerprint: string;
    gitDir: string;
  };
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
  owner?: string;
  name: string;
  signature: string;
  annotations: string[];
  calls: string[];
  evidence: Evidence;
  callSites?: IndexedCall[];
  programmaticTransactions?: ProgrammaticTransaction[];
}
export interface IndexedCall {
  receiverType?: string;
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
  types?: IndexedType[];
  version?: string;
  repoId: string;
  side: Side;
  methods: IndexedMethod[];
  errors: string[];
  filesIndexed: number;
}
export interface IndexedType {
  name: string;
  qualifiedName: string;
  kind: 'interface' | 'class';
  parents: string[];
  imports: string[];
  evidence: Evidence;
}
export interface Contract {
  format?: 'openapi' | 'openapi-fragment' | 'thrift' | 'protobuf' | 'graphql' | 'antlr';
  source?: { before: string | null; after: string | null; patch: string };
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
  /** Where the contract is built and which modules build against it. */
  build?: ContractBuild;
}
export type BuildTool = 'gradle' | 'maven' | 'npm' | 'go' | 'cargo' | 'bazel' | 'dotnet' | 'python';
export interface BuildModule {
  repoId: string;
  /** Module directory relative to the repository root; empty for the root module. */
  dir: string;
  name: string;
  tool: BuildTool;
  evidence: Evidence;
}
export interface ContractBuild {
  /** The module that owns the contract file, or null when no build file encloses it. */
  module: BuildModule | null;
  /** Code generators configured for the contract in its module. */
  generators: string[];
  /** Modules that read the contract file, depend on its module, or depend on such a module. */
  consumers: (BuildModule & {
    via: 'path' | 'dependency' | 'transitive';
    /** For a transitive dependency: the module it builds with. */
    through?: string;
    generators: string[];
  })[];
}
export const changeKinds = [
  'logic',
  'refactor',
  'performance',
  'concurrency',
  'transaction',
  'data',
  'contract',
  'config',
  'cosmetic',
] as const;
/** A short definition of one changed method or file, written once per distinct change. */
export interface ChangeCard {
  id: string;
  name: string;
  evidence: Evidence;
  kind: (typeof changeKinds)[number];
  risk: 'none' | 'check' | 'high';
  text: string;
  /** Describes what the user sees: a change of the user interface. */
  ui?: boolean;
}
export interface AnalysisResult extends ModelResult {
  pendingDescriptions?: {
    id: string;
    title: string;
    section: string;
    summary?: string;
    revisionId: string;
    evidence: Evidence[];
  }[];
  /** Per-change definitions made before the review; absent for reviews made before them. */
  changes?: ChangeCard[];
  testAnalysisVersion?: string;
  sqlAnalysisVersion?: string;
  contracts: Contract[];
  indexes: SourceIndex[];
  /** Stored and API form: keys of the immutable index store; `indexes` is then empty. */
  indexRefs?: string[];
}
export interface AnalysisRun {
  sourceChanges?: ReviewUpdate['changes'];
  conversation?: { home: string };
  messages?: { id: string; at: string; text: string }[];
  usage?: { input: number; cached: number; output: number };
  checkpoint?: {
    stage: 'prepare' | 'review' | 'scenarios' | 'tests' | 'sql' | 'done';
    coreIncomplete?: boolean;
    pending?: AnalysisModelCheckpoint;
  };
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
  /** Optional stages switched off in the settings when this run reached them. */
  skippedSteps?: import('./analysis-steps.js').OptionalStep[];
  error?: string;
}
export interface AnalysisModelCheckpoint {
  keyVersion?: 2;
  promptOverrides?: import('./prompt-templates.js').PromptOverrides;
  key: string;
  home?: string;
  threadId?: string;
  result?: ModelResult;
  testTargets?: IndexedMethod[];
  sqlTargets?: IndexedMethod[];
  localWorkspace?: boolean;
  started?: boolean;
  usageTotal?: { input: number; cached: number; output: number };
}
export interface ProgressEvent {
  seq: number;
  at: string;
  message: string;
  kind?: 'progress' | 'assistant' | 'tool' | 'plan' | 'usage';
}
export interface ReviewSession {
  workflow?: import('./review-workflow.js').ReviewWorkflow;
  contracts?: Contract[];
  contractsVersion?: string;
  id: string;
  title: string;
  createdAt: string;
  snapshots: Snapshot[];
  run: AnalysisRun | null;
  history?: ReviewRevision[];
  update?: ReviewUpdate;
  discussion?: ReviewDiscussion[];
  threadDiscussion?: ReviewDiscussion[];
  /** UI synchronization only; never changes the analysis identity. */
  discussionRevision?: string;
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
  /** The diff the reviewer saw, ending at the commented line; kept when the line moves. */
  diffHunk?: string;
}
export interface ReviewUpdate {
  scopeChanged?: boolean;
  id: string;
  at: string;
  previousReviewId: string;
  changes: { repoId: string; fromSha: string; toSha: string; files: ChangedFile[] }[];
  discussion: ReviewDiscussion[];
  gaps: string[];
}
export interface DraftComment {
  activity?: import('./review-comment.js').CommentActivity[];
  origin?: { snapshotId: string; evidence: Evidence };
  outdated?: boolean;
  id: string;
  body: string;
  evidence: Evidence | null;
  selected: boolean;
  /** A task for Codex in the fix plan, never published to GitHub. */
  forCodex?: boolean;
  /** The GitHub comment this task was made from. */
  discussionId?: string;
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
  /** A new publication on the same commit has a distinct identity. */
  round?: string;
  published?: PublishedReview[];
}
export interface PublishedReview {
  snapshotId: string;
  headSha: string;
  body: string;
  action: ReviewAction;
  comments: DraftComment[];
  submission: Submission;
}
/** Snapshots of the current review and of every saved revision. */
export const sessionSnapshots = (
  session: Pick<ReviewSession, 'snapshots' | 'history' | 'workflow'>,
) => [
  ...session.snapshots,
  ...(session.history ?? []).flatMap((revision) => revision.snapshots),
  ...(session.workflow?.initial.snapshots ?? []),
  ...(session.workflow?.versions ?? []),
];
export const emptyModelResult = (): ModelResult => ({
  summary: '',
  findings: [],
  scenarios: [],
  database: [],
  transactions: [],
  gaps: [],
});
