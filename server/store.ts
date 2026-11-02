import { DatabaseSync } from 'node:sqlite';
import type { PromptOverrides } from '../shared/prompt-templates.js';
import type { OnDemandStep, OptionalStep } from '../shared/analysis-steps.js';
import { isLanguage, type Language } from '../shared/i18n.js';
import type { AnalysisStatistic } from '../shared/analysis-statistics.js';
import type { FixChat } from '../shared/fix-chat.js';
import { completedFixSteps } from '../shared/fix-chat.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  sessionSnapshots,
  type Repository,
  type ReviewDraft,
  type ReviewSession,
  type Side,
  type Snapshot,
  type SourceIndex,
  type AnalysisResult,
} from '../shared/model.js';
import type { ViewedMethod } from '../shared/viewed-methods.js';
import type { SqlCapture } from '../shared/sql-preview.js';
import type { CardDraft } from './change-cards.js';

/** Per file: its text before the first own edit and the hash of the last saved text. */
export interface OwnEdits {
  files: Record<string, { before: string; after: string }>;
}
import { fileViewScope, type ViewedFile } from '../shared/viewed-files.js';
import { t } from '../shared/i18n.js';
import { ensureReviewWorkflow } from '../shared/review-workflow.js';
const INDEX_CACHE_LIMIT = 8;
/** Results whose indexes are still only references; see `attachResult`. */
const lazyIndexes = new WeakMap<AnalysisResult, { refs: string[]; loaded?: SourceIndex[] }>();
/** Indexes are immutable per commit: one stored index per version, repository, side and commit. */
export const indexKey = (
  version: string,
  snapshot: Pick<Snapshot, 'repoId' | 'headSha' | 'mergeBase'>,
  side: Side,
) =>
  `${version}:${snapshot.repoId}:${side}:${side === 'head' ? snapshot.headSha : snapshot.mergeBase}`;
export class Store {
  private db: DatabaseSync;
  private indexCache = new Map<string, SourceIndex>();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));',
    );
  }
  private put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO objects(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json',
      )
      .run(kind, id, JSON.stringify(value));
  }
  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM objects WHERE kind=? AND id=?').get(kind, id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }
  private list<T>(kind: string): T[] {
    return (
      this.db.prepare('SELECT json FROM objects WHERE kind=? ORDER BY rowid DESC').all(kind) as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json) as T);
  }
  pullRequestPreview(id: string) {
    return this.get<import('../shared/pull-request-workflow.js').PullRequestPreview>(
      'pr-publication',
      id,
    );
  }
  savePullRequestPreview(value: import('../shared/pull-request-workflow.js').PullRequestPreview) {
    this.put('pr-publication', value.id, value);
  }
  pullRequestPreviews(sessionId: string) {
    return this.list<import('../shared/pull-request-workflow.js').PullRequestPreview>(
      'pr-publication',
    ).filter((p) => p.sessionId === sessionId);
  }
  repositories() {
    return this.list<Repository>('repository');
  }
  promptOverrides(): PromptOverrides {
    return this.get<PromptOverrides>('settings', 'analysis-prompts') ?? {};
  }
  savePromptOverrides(prompts: PromptOverrides) {
    this.put('settings', 'analysis-prompts', prompts);
  }
  /** The interface and response language chosen in the settings. */
  language(): Language | undefined {
    const value = this.get<{ language: string }>('settings', 'language')?.language;
    return isLanguage(value) ? value : undefined;
  }
  saveLanguage(language: Language) {
    this.put('settings', 'language', { language });
  }
  /** Optional analysis stages switched off in the settings. */
  disabledSteps(): OptionalStep[] {
    return this.get<OptionalStep[]>('settings', 'disabled-steps') ?? [];
  }
  saveDisabledSteps(steps: OptionalStep[]) {
    this.put('settings', 'disabled-steps', steps);
  }
  /** Stages that run on request for the method being looked at. */
  onDemandSteps(): OnDemandStep[] {
    return this.get<OnDemandStep[]>('settings', 'on-demand-steps') ?? [];
  }
  saveOnDemandSteps(steps: OnDemandStep[]) {
    this.put('settings', 'on-demand-steps', steps);
  }
  /** When each feedback issue was last opened in the app, by issue number. */
  feedbackSeen(): Record<number, string> {
    return this.get<Record<number, string>>('settings', 'feedback-seen') ?? {};
  }
  saveFeedbackSeen(seen: Record<number, string>) {
    this.put('settings', 'feedback-seen', seen);
  }
  /** The GitHub account chosen in the app as its current user. */
  githubUser(): string | undefined {
    return this.get<{ login: string }>('settings', 'github-user')?.login;
  }
  saveGitHubUser(login: string | null) {
    if (login) this.put('settings', 'github-user', { login });
    else
      this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run('settings', 'github-user');
  }
  analysisStatistics() {
    return this.list<AnalysisStatistic>('analysis-statistic');
  }
  analysisStatistic(id: string) {
    return this.get<AnalysisStatistic>('analysis-statistic', id);
  }
  saveAnalysisStatistic(stat: AnalysisStatistic) {
    stat.updatedAt = new Date().toISOString();
    this.put('analysis-statistic', stat.id, stat);
  }
  repository(id: string) {
    return this.get<Repository>('repository', id);
  }
  saveRepository(repo: Repository) {
    this.put('repository', repo.id, repo);
  }
  /** Summaries for listing and cleanup: analysis indexes stay as references. */
  sessions() {
    return this.list<ReviewSession>('session');
  }
  session(id: string) {
    const session = this.get<ReviewSession>('session', id);
    if (!session) return undefined;
    ensureReviewWorkflow(session, this.drafts(id));
    return this.attachSession(session);
  }
  saveSession(session: ReviewSession) {
    ensureReviewWorkflow(session, this.drafts(session.id));
    // Analysis, remote sync and publications can save concurrently. Their workflow records
    // are additive and must never disappear when an older technical run saves progress.
    const saved = this.get<ReviewSession>('session', session.id)?.workflow;
    if (saved) {
      const workflow = session.workflow!;
      workflow.checkpoints = [
        ...new Map([...saved.checkpoints, ...workflow.checkpoints].map((c) => [c.key, c])).values(),
      ].sort((a, b) => a.at.localeCompare(b.at));
      workflow.versions = [
        ...new Map([...saved.versions, ...workflow.versions].map((s) => [s.id, s])).values(),
      ];
      if (saved.initial.at > workflow.initial.at) workflow.initial = saved.initial;
      const remote = new Map((workflow.remote ?? []).map((r) => [r.repoId, r]));
      for (const state of saved.remote ?? [])
        if (!remote.has(state.repoId) || remote.get(state.repoId)!.at < state.at)
          remote.set(state.repoId, state);
      if (remote.size) workflow.remote = [...remote.values()];
      workflow.fixUpdates = { ...saved.fixUpdates, ...workflow.fixUpdates };
      for (const [key, state] of Object.entries(saved.fixUpdates ?? {}))
        if (workflow.fixUpdates[key].at < state.at || state.state === 'complete')
          workflow.fixUpdates[key] = state;
    }
    this.put('session', session.id, this.detachSession(session));
  }
  /** A new source version and its relocated drafts become visible together. */
  saveReviewUpdate(session: ReviewSession, drafts: ReviewDraft[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveSession(session);
      for (const draft of drafts) this.saveDraft(draft);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Results reference immutable stored indexes; embedding them made each save tens of MB. */
  detachResult(result: AnalysisResult, snapshots: Snapshot[]): AnalysisResult {
    const lazy = lazyIndexes.get(result);
    if (lazy && !lazy.loaded) {
      // Nothing read the indexes since loading, so the stored references are still exact.
      const rest = Object.fromEntries(
        Object.keys(result)
          .filter((key) => key !== 'indexes')
          .map((key) => [key, result[key as keyof AnalysisResult]]),
      );
      return { ...rest, indexes: [], indexRefs: lazy.refs } as unknown as AnalysisResult;
    }
    if (!result.indexes.length) return result;
    const refs = result.indexes.map((index) => {
      const snapshot = snapshots.find((item) => item.repoId === index.repoId);
      return snapshot && indexKey(index.version ?? 'unversioned', snapshot, index.side);
    });
    if (refs.some((ref) => !ref)) return result;
    result.indexes.forEach((index, i) => {
      if (!this.hasIndex(refs[i]!)) this.saveIndex(refs[i]!, index);
    });
    return { ...result, indexes: [], indexRefs: refs as string[] };
  }
  detachSession(session: ReviewSession): ReviewSession {
    return {
      ...session,
      run: session.run && {
        ...session.run,
        result: this.detachResult(session.run.result, session.snapshots),
      },
      ...(session.history && {
        history: session.history.map((revision) => ({
          ...revision,
          run: {
            ...revision.run,
            result: this.detachResult(revision.run.result, revision.snapshots),
          },
        })),
      }),
    };
  }
  /**
   * Indexes are tens of MB per review with history, and most requests never read them: they are
   * loaded on first access instead of with every session.
   */
  private attachResult(result: AnalysisResult): AnalysisResult {
    if (!result.indexRefs) return result;
    const { indexRefs, ...rest } = result;
    const attached = rest as AnalysisResult;
    const lazy: { refs: string[]; loaded?: SourceIndex[] } = { refs: indexRefs };
    Object.defineProperty(attached, 'indexes', {
      enumerable: true,
      configurable: true,
      get: () => (lazy.loaded ??= indexRefs.flatMap((ref) => this.index(ref) ?? [])),
      set: (indexes: SourceIndex[]) => (lazy.loaded = indexes),
    });
    lazyIndexes.set(attached, lazy);
    return attached;
  }
  private attachSession(session: ReviewSession): ReviewSession {
    return {
      ...session,
      run: session.run && { ...session.run, result: this.attachResult(session.run.result) },
      ...(session.history && {
        history: session.history.map((revision) => ({
          ...revision,
          run: { ...revision.run, result: this.attachResult(revision.run.result) },
        })),
      }),
    };
  }
  deleteSession(id: string) {
    const session = this.session(id);
    if (!session) return;
    const fingerprints = (value: ReviewSession) =>
      [
        value.run?.fingerprint,
        ...(value.history ?? []).map((revision) => revision.run.fingerprint),
      ].filter((key): key is string => !!key);
    const retained = new Set(
      this.sessions()
        .filter((value) => value.id !== id)
        .flatMap(fingerprints),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?');
      for (const draft of this.drafts(id)) remove.run('draft', `${id}:${draft.snapshotId}`);
      for (const capture of this.list<SqlCapture>('sql-capture').filter(
        (item) => item.sessionId === id,
      ))
        remove.run('sql-capture', capture.id);
      for (const key of fingerprints(session))
        if (!retained.has(key)) remove.run('analysis-result', key);
      const retainedScopes = new Set(
        this.sessions()
          .filter((item) => item.id !== id)
          .flatMap((item) =>
            sessionSnapshots(item).map((snapshot) => fileViewScope(snapshot, item.id)),
          ),
      );
      const scopes = new Set(
        sessionSnapshots(session).map((snapshot) => fileViewScope(snapshot, id)),
      );
      for (const mark of this.viewedFiles())
        if (scopes.has(mark.scope) && !retainedScopes.has(mark.scope))
          remove.run('viewed-file', mark.id);
      for (const mark of this.viewedMethods())
        if (scopes.has(mark.scope) && !retainedScopes.has(mark.scope))
          remove.run('viewed-method', mark.id);
      remove.run('fix-chat', id);
      for (const publication of this.pullRequestPreviews(id))
        remove.run('pr-publication', publication.id);
      for (const view of this.list<{ sessionId: string; snapshot: Snapshot }>(
        'comparison-snapshot',
      ))
        if (view.sessionId === id) remove.run('comparison-snapshot', view.snapshot.id);
      remove.run('session', id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  drafts(sessionId: string) {
    return this.list<ReviewDraft>('draft').filter((d) => d.sessionId === sessionId);
  }
  viewedMethods() {
    return this.list<ViewedMethod>('viewed-method');
  }
  saveViewedMethod(mark: ViewedMethod) {
    this.put('viewed-method', mark.id, mark);
  }
  deleteViewedMethod(id: string) {
    this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run('viewed-method', id);
  }
  viewedFiles() {
    return this.list<ViewedFile>('viewed-file');
  }
  saveViewedFile(mark: ViewedFile) {
    this.put('viewed-file', mark.id, mark);
  }
  deleteViewedFile(id: string) {
    this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run('viewed-file', id);
  }
  draft(sessionId: string, snapshotId: string) {
    return this.get<ReviewDraft>('draft', `${sessionId}:${snapshotId}`);
  }
  saveDraft(draft: ReviewDraft) {
    this.put('draft', `${draft.sessionId}:${draft.snapshotId}`, draft);
  }
  fixChat(sessionId: string) {
    const chat = this.get<FixChat>('fix-chat', sessionId);
    if (!chat) return chat;
    const current = this.session(sessionId);
    const snapshots = current ? sessionSnapshots(current) : [];
    const comments = this.drafts(sessionId)
      .filter(
        (draft) =>
          draft.snapshotId === chat.snapshotId ||
          snapshots.some(
            (snapshot) => snapshot.id === draft.snapshotId && snapshot.repoId === chat.repoId,
          ),
      )
      .flatMap((draft) => draft.comments);
    return { ...chat, completedSteps: completedFixSteps(chat, comments) };
  }
  saveFixChat(chat: FixChat) {
    this.put('fix-chat', chat.sessionId, chat);
  }
  comparisonSnapshot(id: string) {
    return this.get<{ sessionId: string; snapshot: Snapshot; origins: string[] }>(
      'comparison-snapshot',
      id,
    );
  }
  saveComparisonSnapshot(value: { sessionId: string; snapshot: Snapshot; origins: string[] }) {
    this.put('comparison-snapshot', value.snapshot.id, value);
  }
  /** Polled every few seconds, so it reads chats and titles without parsing whole sessions. */
  pendingFixChats() {
    return (
      this.db
        .prepare(
          `SELECT chat.json AS chat, json_extract(session.json, '$.title') AS title
           FROM objects chat JOIN objects session ON session.kind = 'session' AND session.id = chat.id
           WHERE chat.kind = 'fix-chat' AND json_extract(chat.json, '$.pending') IS NOT NULL
           ORDER BY session.rowid DESC`,
        )
        .all() as { chat: string; title: string }[]
    ).map((row) => ({ chat: JSON.parse(row.chat) as FixChat, title: row.title }));
  }
  /** Files the reviewer saved through the editor since Codex last accepted the folder. */
  ownEdits(sessionId: string, repoId: string) {
    return this.get<OwnEdits>('own-edits', `${sessionId}:${repoId}`);
  }
  saveOwnEdits(sessionId: string, repoId: string, edits: OwnEdits) {
    this.put('own-edits', `${sessionId}:${repoId}`, edits);
  }
  clearOwnEdits(sessionId: string, repoId: string) {
    this.db
      .prepare('DELETE FROM objects WHERE kind=? AND id=?')
      .run('own-edits', `${sessionId}:${repoId}`);
  }
  changeCard(key: string) {
    return this.get<CardDraft>('change-card', key);
  }
  saveChangeCard(key: string, card: CardDraft) {
    this.put('change-card', key, card);
  }
  analysisResult(key: string) {
    const result = this.get<AnalysisResult>('analysis-result', key);
    return result && this.attachResult(result);
  }
  sqlCapture(id: string) {
    return this.get<SqlCapture>('sql-capture', id);
  }
  saveSqlCapture(capture: SqlCapture) {
    this.put('sql-capture', capture.id, capture);
  }
  saveAnalysisResult(key: string, result: AnalysisResult, snapshots: Snapshot[]) {
    this.put('analysis-result', key, this.detachResult(result, snapshots));
  }
  index(key: string) {
    const index = this.indexCache.get(key) ?? this.get<SourceIndex>('index', key);
    if (index) this.rememberIndex(key, index);
    return index;
  }
  saveIndex(key: string, index: SourceIndex) {
    this.put('index', key, index);
    this.rememberIndex(key, index);
  }
  private hasIndex(key: string) {
    return (
      this.indexCache.has(key) ||
      !!this.db.prepare('SELECT 1 FROM objects WHERE kind=? AND id=?').get('index', key)
    );
  }
  private rememberIndex(key: string, index: SourceIndex) {
    this.indexCache.delete(key);
    this.indexCache.set(key, index);
    if (this.indexCache.size > INDEX_CACHE_LIMIT)
      this.indexCache.delete(this.indexCache.keys().next().value!);
  }
  recover() {
    for (const session of this.sessions()) {
      const chat = this.fixChat(session.id);
      if (chat && ['planning', 'applying'].includes(chat.state)) {
        chat.state = 'failed';
        chat.error = t(
          'Work was interrupted by a restart. Check the working folder and refresh the review before a new plan.',
        );
        this.saveFixChat(chat);
      }
      // Sessions saved with embedded indexes are compacted once instead of on their next change.
      const embedded = [session.run, ...(session.history ?? []).map((item) => item.run)].some(
        (run) => run?.result.indexes.length,
      );
      if (session.run?.state === 'running') {
        session.run.state = 'failed';
        session.run.finishedAt = new Date().toISOString();
        session.run.result.gaps.push(
          t('The analysis was interrupted by an app restart. Run it again.'),
        );
        this.saveSession(session);
      } else if (embedded) this.saveSession(session);
      for (const draft of this.drafts(session.id))
        if (draft.state === 'submitting') {
          draft.state = 'uncertain';
          this.saveDraft(draft);
        }
    }
  }
  close() {
    this.db.close();
  }
}
