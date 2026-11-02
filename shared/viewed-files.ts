import type { Snapshot } from './model.js';
export interface ViewedFile {
  id: string;
  scope: string;
  path: string;
  hash: string;
  viewedAt: string;
}
export interface FileViewStatus {
  snapshotId: string;
  path: string;
  viewed: boolean;
}
export function fileViewScope(snapshot: Snapshot, sessionId: string): string {
  return JSON.stringify([
    snapshot.repoId,
    snapshot.pr ? `pr:${snapshot.pr.number}` : `context:${sessionId}`,
  ]);
}
export function reviewFilePath(snapshot: Snapshot, path: string): string {
  if (snapshot.headFiles.includes(path) || snapshot.files.some((file) => file.path === path))
    return path;
  return snapshot.files.find((file) => file.oldPath === path)?.path ?? path;
}
export function fileExtension(path: string): string {
  const name = path.split('/').pop()!;
  return name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
}
