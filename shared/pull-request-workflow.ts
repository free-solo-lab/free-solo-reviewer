import type { PullRequest } from './model.js';
export interface PullRequestPreview {
  existingPr?: number;
  id: string;
  sessionId: string;
  repoId: string;
  snapshotId: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  files: string[];
  fingerprint: string;
  parent: string;
  state: 'prepared' | 'committed' | 'pushed' | 'uncertain' | 'complete';
  commit?: string;
  pullRequest?: PullRequest;
}
