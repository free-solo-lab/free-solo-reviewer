import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Repository,
  ReviewDraft,
  ReviewSession,
  SourceIndex,
  AnalysisResult,
} from '../shared/model.js';
import type { ViewedMethod } from '../shared/viewed-methods.js';
import type { SqlCapture } from '../shared/sql-preview.js';
import { fileViewScope, type ViewedFile } from '../shared/viewed-files.js';
export class Store {
  private db: DatabaseSync;
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
  repositories() {
    return this.list<Repository>('repository');
  }
  repository(id: string) {
    return this.get<Repository>('repository', id);
  }
  saveRepository(repo: Repository) {
    this.put('repository', repo.id, repo);
  }
  sessions() {
    return this.list<ReviewSession>('session');
  }
  session(id: string) {
    return this.get<ReviewSession>('session', id);
  }
  saveSession(session: ReviewSession) {
    this.put('session', session.id, session);
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
            [
              ...item.snapshots,
              ...(item.history ?? []).flatMap((revision) => revision.snapshots),
            ].map((snapshot) => fileViewScope(snapshot, item.id)),
          ),
      );
      const scopes = new Set(
        [
          ...session.snapshots,
          ...(session.history ?? []).flatMap((revision) => revision.snapshots),
        ].map((snapshot) => fileViewScope(snapshot, id)),
      );
      for (const mark of this.viewedFiles())
        if (scopes.has(mark.scope) && !retainedScopes.has(mark.scope))
          remove.run('viewed-file', mark.id);
      for (const mark of this.viewedMethods())
        if (scopes.has(mark.scope) && !retainedScopes.has(mark.scope))
          remove.run('viewed-method', mark.id);
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
  analysisResult(key: string) {
    return this.get<AnalysisResult>('analysis-result', key);
  }
  sqlCapture(id: string) {
    return this.get<SqlCapture>('sql-capture', id);
  }
  saveSqlCapture(capture: SqlCapture) {
    this.put('sql-capture', capture.id, capture);
  }
  saveAnalysisResult(key: string, result: AnalysisResult) {
    this.put('analysis-result', key, result);
  }
  index(key: string) {
    return this.get<SourceIndex>('index', key);
  }
  saveIndex(key: string, index: SourceIndex) {
    this.put('index', key, index);
  }
  recover() {
    for (const session of this.sessions()) {
      if (session.run?.state === 'running') {
        session.run.state = 'failed';
        session.run.finishedAt = new Date().toISOString();
        session.run.result.gaps.push(
          'Анализ прерван перезапуском приложения. Запустите его повторно.',
        );
        this.saveSession(session);
      }
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
