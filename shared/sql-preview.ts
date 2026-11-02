import type { Evidence } from './model.js';
export interface SqlPreview {
  evidence: Evidence;
  snapshotId: string;
  headSha: string;
  method: string;
  framework: 'jooq' | 'hibernate' | 'jdbc' | 'unknown';
  origin: 'captured' | 'source' | 'reconstructed' | 'model' | 'unavailable';
  sql: string;
  dialect: string;
  renderer?: string;
  parameters: { position: number; expression: string }[];
  unknowns: string[];
  variants?: {
    title: string;
    sql: string;
    parameters: SqlPreview['parameters'];
    unknowns: string[];
  }[];
}
export interface SqlCapture {
  id: string;
  sessionId: string;
  preview: SqlPreview;
}
