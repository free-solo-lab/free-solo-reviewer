import { createHash } from 'node:crypto';
import type { Snapshot } from '../shared/model.js';
import { fileViewScope, reviewFilePath, type FileViewStatus } from '../shared/viewed-files.js';
import { readSource } from './repository.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { t } from '../shared/i18n.js';

export class ViewedFiles {
  constructor(private store: Store) {}
  private async version(snapshot: Snapshot, path: string) {
    const canonical = reviewFilePath(snapshot, path);
    const present = snapshot.headFiles.includes(canonical);
    const changed = snapshot.files.find((file) => file.path === canonical);
    if (!present && !changed)
      throw new AppError(t('The file is missing in the snapshot tree.'), 404);
    const text = await readSource(snapshot, {
      side: present ? 'head' : 'base',
      path: present ? canonical : (changed?.oldPath ?? canonical),
    });
    return {
      path: canonical,
      hash: createHash('sha256')
        .update(present ? 'present\0' : 'deleted\0')
        .update(text)
        .digest('hex'),
    };
  }
  async list(sessionId: string, snapshots: Snapshot[]): Promise<FileViewStatus[]> {
    const records = this.store.viewedFiles();
    const result: FileViewStatus[] = [];
    for (const snapshot of snapshots) {
      const marks = records.filter((mark) => mark.scope === fileViewScope(snapshot, sessionId));
      for (let i = 0; i < marks.length; i += 16) {
        const statuses = await Promise.all(
          marks.slice(i, i + 16).map(async (mark) => {
            const path = reviewFilePath(snapshot, mark.path);
            if (
              path !== mark.path ||
              (!snapshot.headFiles.includes(path) &&
                !snapshot.files.some((file) => file.path === path))
            )
              return null;
            try {
              const version = await this.version(snapshot, path);
              return version.hash === mark.hash
                ? { snapshotId: snapshot.id, path, viewed: true }
                : null;
            } catch {
              return null;
            }
          }),
        );
        for (const status of statuses) if (status) result.push(status);
      }
    }
    return result;
  }
  async set(
    sessionId: string,
    snapshot: Snapshot,
    path: string,
    viewed: boolean,
  ): Promise<FileViewStatus> {
    const version = await this.version(snapshot, path),
      scope = fileViewScope(snapshot, sessionId);
    const id = JSON.stringify([scope, version.path]);
    if (viewed)
      this.store.saveViewedFile({
        id,
        scope,
        path: version.path,
        hash: version.hash,
        viewedAt: new Date().toISOString(),
      });
    else if (this.store.viewedFiles().find((mark) => mark.id === id)?.hash === version.hash)
      this.store.deleteViewedFile(id);
    return { snapshotId: snapshot.id, path: version.path, viewed };
  }
}
