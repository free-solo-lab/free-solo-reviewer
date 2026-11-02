import { z } from 'zod';
import {
  confidenceSchema,
  databaseSchema,
  findingSchema,
  modelResultSchema,
  scenarioSchema,
  type Evidence,
  type Snapshot,
} from '../shared/model.js';
import type { SkeletonEdge } from '../shared/scenario-skeleton.js';
import { t } from '../shared/i18n.js';

/**
 * The model writes most of its answer as evidence, so the wire format keeps it short: a changed
 * file is `F3:47-51` (head) or `F3@base:47`, any other file is its workspace path
 * `repo-1/head/src/A.kt:47-51`, and services are their workspace directories (`repo-1`).
 * Ids of steps and other values that follow from the structure are filled in locally.
 */
export interface WireRefs {
  files: Map<string, { repoId: string; path: string; oldPath?: string }>;
  repos: Map<string, string>;
  /** Scenario call edges found locally; a step names one instead of repeating it. */
  edges?: Map<string, SkeletonEdge>;
  /** Methods the SQL stage asks about; a query points at the lines inside one of them. */
  methods?: Evidence[];
}

/** Numbers the changed files of a review in a stable order; the same input gives the same ids. */
export function wireRefs(snapshots: Snapshot[]): WireRefs {
  const files: WireRefs['files'] = new Map(),
    repos: WireRefs['repos'] = new Map();
  snapshots.forEach((snapshot, i) => {
    repos.set(`repo-${i + 1}`, snapshot.repoId);
    for (const file of snapshot.files)
      files.set(`F${files.size + 1}`, {
        repoId: snapshot.repoId,
        path: file.path,
        ...(file.oldPath && { oldPath: file.oldPath }),
      });
  });
  return { files, repos };
}

export function toRef(evidence: Evidence, refs: WireRefs) {
  const lines =
    evidence.endLine > evidence.startLine
      ? `${evidence.startLine}-${evidence.endLine}`
      : `${evidence.startLine}`;
  for (const [id, file] of refs.files)
    if (
      file.repoId === evidence.repoId &&
      (evidence.side === 'head' ? file.path : (file.oldPath ?? file.path)) === evidence.path
    )
      return `${id}${evidence.side === 'base' ? '@base' : ''}:${lines}`;
  return `${repoDir(evidence.repoId, refs)}/${evidence.side}/${evidence.path}:${lines}`;
}
const repoDir = (repoId: string, refs: WireRefs) =>
  [...refs.repos].find(([, id]) => id === repoId)?.[0] ?? repoId;

export function fromRef(text: string, refs: WireRefs): Evidence | null {
  const lines = (start: string, end?: string) => {
    const startLine = Number(start),
      endLine = Number(end ?? start);
    return startLine > 0 && endLine >= startLine ? { startLine, endLine } : null;
  };
  const alias = text.trim().match(/^(F\d+)(?:@(base|head))?:(\d+)(?:-(\d+))?$/);
  if (alias) {
    const file = refs.files.get(alias[1]),
      range = lines(alias[3], alias[4]);
    if (!file || !range) return null;
    const side = alias[2] === 'base' ? 'base' : 'head';
    const path = side === 'base' ? (file.oldPath ?? file.path) : file.path;
    return { repoId: file.repoId, side, path, ...range };
  }
  const path = text.trim().match(/^(repo-\d+)\/(head|base)\/(.+):(\d+)(?:-(\d+))?$/);
  const repoId = path && refs.repos.get(path[1]);
  const range = path && lines(path[4], path[5]);
  if (!path || !repoId || !range || path[3].split('/').includes('..')) return null;
  return { repoId, side: path[2] as Evidence['side'], path: path[3], ...range };
}

/**
 * Every ref in a text the model wrote as one: `F3:19-41,46-67; F5:30` is three ranges in two
 * files. A single ref reads exactly as with fromRef.
 */
export function fromRefs(text: string, refs: WireRefs): Evidence[] {
  const single = fromRef(text, refs);
  if (single) return [single];
  return [
    ...text.matchAll(
      /(F\d+(?:@(?:base|head))?|repo-\d+\/(?:head|base)\/[^\s:;,]+):(\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*)/g,
    ),
  ].flatMap(([, file, ranges]) =>
    ranges.split(',').flatMap((range) => fromRef(`${file}:${range.trim()}`, refs) ?? []),
  );
}
const within = (evidence: Evidence, method: Evidence) =>
  evidence.repoId === method.repoId &&
  evidence.side === method.side &&
  evidence.path === method.path &&
  evidence.startLine <= method.endLine &&
  evidence.endLine >= method.startLine;
/** The lines of a query inside its method; the other refs stay as the operation's evidence. */
function queryEvidence(candidates: Evidence[], methods: Evidence[] = []) {
  for (const evidence of candidates) {
    const method = methods.find((item) => within(evidence, item));
    if (method)
      return {
        ...evidence,
        startLine: Math.max(evidence.startLine, method.startLine),
        endLine: Math.min(evidence.endLine, method.endLine),
      };
  }
  return candidates[0];
}

const refList = z.array(z.string());
const claim = {
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  confidence: confidenceSchema,
  evidence: refList,
};
const step = scenarioSchema.shape.steps.element.shape;
const query = databaseSchema.shape.query.unwrap().unwrap().shape;
export const wireSchema = z.object({
  summary: z.string(),
  findings: z.array(z.object({ ...claim, severity: findingSchema.shape.severity })),
  scenarios: z.array(
    z.object({
      ...claim,
      services: z.array(z.string()),
      steps: z.array(
        z.object({
          edge: z.string(),
          description: z.string(),
          from: z.string(),
          to: z.string(),
          label: z.string(),
          kind: step.kind,
          change: step.change,
          branch: z.string(),
          evidence: refList,
        }),
      ),
    }),
  ),
  database: z.array(
    databaseSchema.extend({
      evidence: refList,
      query: z
        .object({
          method: query.method,
          framework: query.framework,
          evidence: z.string(),
          parameters: query.parameters,
        })
        .nullable(),
    }),
  ),
  gaps: z.array(z.string()),
  followUp: z
    .object({
      summary: z.string(),
      items: z.array(
        z.object({
          ...modelResultSchema.shape.followUp.unwrap().shape.items.element.omit({ evidence: true })
            .shape,
          evidence: refList,
        }),
      ),
    })
    .nullable(),
});
export const wireOutputSchema = z.toJSONSchema(wireSchema);

/** Expands a wire answer to the stored model result; unknown refs are dropped and reported. */
export function fromWire(raw: unknown, refs: WireRefs): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  let dropped = false;
  const expand = (values: unknown) =>
    Array.isArray(values)
      ? values.flatMap((value) => {
          const evidence = typeof value === 'string' ? fromRefs(value, refs) : [];
          if (!evidence.length) dropped = true;
          return evidence;
        })
      : [];
  const service = (value: unknown) =>
    typeof value === 'string' ? (refs.repos.get(value) ?? value) : value;
  const object = raw as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(object[key]) ? (object[key] as object[]) : []);
  const result: Record<string, unknown> = {
    ...object,
    findings: list('findings').map((finding) => ({
      ...finding,
      evidence: expand((finding as { evidence?: unknown }).evidence),
    })),
    scenarios: list('scenarios').map((item) => {
      const scenario = item as Record<string, unknown> & { id?: string; steps?: unknown };
      return {
        ...scenario,
        evidence: expand(scenario.evidence),
        services: Array.isArray(scenario.services) ? scenario.services.map(service) : [],
        steps: (Array.isArray(scenario.steps) ? scenario.steps : []).map(
          ({ edge: id, ...value }: Record<string, unknown>, i: number) => {
            const edge = typeof id === 'string' ? refs.edges?.get(id) : undefined;
            const evidence = expand(value.evidence);
            const text = typeof value.label === 'string' ? value.label.trim() : '';
            return {
              ...value,
              id: `${scenario.id}.${i + 1}`,
              from: edge?.repoId ?? service(value.from),
              to: edge?.repoId ?? service(value.to),
              ...(edge && {
                // Endpoint names identify the participants; the model adds only the meaning.
                label: text.includes('->')
                  ? text
                  : `${edge.caller} -> ${edge.callee}${text ? `: ${text}` : ''}`,
                kind: edge.kind,
              }),
              confidence: 'extracted',
              evidence: edge && !evidence.length ? edge.evidence : evidence,
            };
          },
        ),
      };
    }),
    database: list('database').map((item) => {
      const operation = item as Record<string, unknown> & {
        query?: Record<string, unknown> | null;
      };
      const candidates = operation.query ? expand([operation.query.evidence]) : [];
      const evidence = queryEvidence(candidates, refs.methods);
      const other = expand(operation.evidence);
      for (const item of candidates)
        if (!other.some((known) => JSON.stringify(known) === JSON.stringify(item)))
          other.push(item);
      return {
        ...operation,
        evidence: other,
        query: operation.query && evidence ? { ...operation.query, evidence } : null,
      };
    }),
  };
  const followUp = object.followUp as { items?: unknown } | null | undefined;
  if (followUp && Array.isArray(followUp.items))
    result.followUp = {
      ...followUp,
      items: followUp.items.map((item: { evidence?: unknown }) => ({
        ...item,
        evidence: expand(item.evidence),
      })),
    };
  if (dropped)
    result.gaps = [
      ...(Array.isArray(object.gaps) ? object.gaps : []),
      t('Model references in an unknown format were dropped.'),
    ];
  return result;
}
