import { createHash } from 'node:crypto';
import type { Side, Snapshot } from '../shared/model.js';
import type { MethodView } from '../shared/viewed-methods.js';
import { fileViewScope, reviewFilePath } from '../shared/viewed-files.js';
import { readSource } from './repository.js';
import { indexSnapshot, INDEX_VERSION } from './indexer.js';
import { Store } from './store.js';
import { AppError } from './process.js';

export class ViewedMethods {
  constructor(private store: Store) {}
  private async versions(sessionId: string, snapshot: Snapshot, path: string, side: Side) {
    const indexKey = `${INDEX_VERSION}:${snapshot.repoId}:${side}:${side === 'head' ? snapshot.headSha : snapshot.mergeBase}`;
    let index = this.store.index(indexKey);
    if (!index) {
      index = await indexSnapshot(snapshot, side);
      this.store.saveIndex(indexKey, index);
    }
    const lines = (await readSource(snapshot, { path, side })).split('\n');
    const scope = fileViewScope(snapshot, sessionId);
    const occurrences = new Map<string, number>();
    return index.methods
      .filter((method) => method.evidence.path === path)
      .map((method) => {
        // Content-based marks survive line shifts but reset when this method changes.
        const text = lines.slice(method.evidence.startLine - 1, method.evidence.endLine).join('\n');
        const hash = createHash('sha256')
          .update(method.signature)
          .update('\0')
          .update(text)
          .digest('hex');
        const occurrence = occurrences.get(hash) ?? 0;
        occurrences.set(hash, occurrence + 1);
        const key = JSON.stringify([scope, reviewFilePath(snapshot, path), hash, occurrence]);
        return { key, hash, scope, path: reviewFilePath(snapshot, path), method };
      });
  }
  async list(
    sessionId: string,
    snapshot: Snapshot,
    path: string,
    side: Side,
  ): Promise<MethodView[]> {
    const marks = new Set(this.store.viewedMethods().map((mark) => mark.id));
    return (await this.versions(sessionId, snapshot, path, side)).map(({ key, method }) => ({
      key,
      method,
      viewed: marks.has(key),
    }));
  }
  async set(
    sessionId: string,
    snapshot: Snapshot,
    path: string,
    side: Side,
    line: number,
    viewed: boolean,
  ): Promise<MethodView> {
    const entry = (await this.versions(sessionId, snapshot, path, side)).find(
      (entry) => entry.method.evidence.startLine === line,
    );
    if (!entry) throw new AppError('Метод не найден.', 404);
    if (viewed)
      this.store.saveViewedMethod({
        id: entry.key,
        scope: entry.scope,
        path: entry.path,
        hash: entry.hash,
        viewedAt: new Date().toISOString(),
      });
    else this.store.deleteViewedMethod(entry.key);
    return { key: entry.key, method: entry.method, viewed };
  }
}
