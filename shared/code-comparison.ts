import type { ChangedFile } from './model.js';
export interface CodeComparison {
  previousRevisionId: string;
  previousSnapshotId: string;
  previousSha: string;
  currentSnapshotId: string;
  currentSha: string;
  previousPath: string;
  path: string;
  text: string;
  file: ChangedFile;
}
