import type { AnalysisResult, ReviewSession, SourceIndex, Evidence } from '../shared/model';
import { unpackIndex } from '../shared/index-wire';
import { comparisonReview } from '../shared/review-display';
import { api } from './api';

/** Enough for the current analysis and a comparison of several repositories, both sides. */
const INDEX_CACHE_LIMIT = 16;
const indexes = new Map<string, Promise<SourceIndex>>();
const navigation = new Map<string, Promise<SourceIndex>>();
const sources = new Map<string, Promise<{ text: string }>>();
/** Snapshot files are immutable and shared by every code block of a scenario. */
export function loadSnapshotSource(sessionId: string, snapshotId: string, evidence: Evidence) {
  const key = JSON.stringify([
    sessionId,
    snapshotId,
    evidence.repoId,
    evidence.side,
    evidence.path,
  ]);
  let pending = sources.get(key);
  if (!pending) {
    pending = api<{ text: string }>(
      `/sessions/${sessionId}/source?${new URLSearchParams({ repoId: evidence.repoId, side: evidence.side, path: evidence.path, snapshotId })}`,
    );
    sources.set(key, pending);
    pending.catch(() => sources.delete(key));
    if (sources.size > 24) sources.delete(sources.keys().next().value!);
  }
  return pending;
}
export function loadNavigationIndex(sessionId: string, snapshotId: string, side: 'head' | 'base') {
  const key = JSON.stringify([sessionId, snapshotId, side]);
  let result = navigation.get(key);
  if (!result) {
    result = api<SourceIndex>(
      `/sessions/${sessionId}/navigation-index?${new URLSearchParams({ snapshotId, side })}`,
    ).then(unpackIndex);
    navigation.set(key, result);
    result.catch(() => navigation.delete(key));
    if (navigation.size > INDEX_CACHE_LIMIT) navigation.delete(navigation.keys().next().value!);
  }
  return result;
}

function loadIndex(ref: string) {
  let index = indexes.get(ref);
  if (index) indexes.delete(ref);
  else {
    index = api<SourceIndex>(`/indexes/${encodeURIComponent(ref)}`).then(unpackIndex);
    index.catch(() => indexes.delete(ref));
  }
  indexes.set(ref, index);
  if (indexes.size > INDEX_CACHE_LIMIT) indexes.delete(indexes.keys().next().value!);
  return index;
}

async function attach(result: AnalysisResult): Promise<AnalysisResult> {
  if (!result.indexRefs) return result;
  const { indexRefs, ...rest } = result;
  return { ...rest, indexes: await Promise.all(indexRefs.map(loadIndex)) };
}
/** The indexes of a result, downloading them if the session arrived without them. */
export async function resultIndexes(result: AnalysisResult) {
  return result.indexRefs ? Promise.all(result.indexRefs.map(loadIndex)) : result.indexes;
}

/**
 * Sessions arrive with index references; each index is downloaded once and shared. Only the
 * current analysis and the review it is compared with are needed to show a session; older
 * revisions keep their references until a comparison asks for them (see `resultIndexes`).
 */
export async function hydrateSession(session: ReviewSession): Promise<ReviewSession> {
  const compared = comparisonReview(session)?.run.id;
  const [run, history] = await Promise.all([
    session.run && attach(session.run.result).then((result) => ({ ...session.run!, result })),
    session.history &&
      Promise.all(
        session.history.map(async (revision) =>
          revision.run.id === compared
            ? { ...revision, run: { ...revision.run, result: await attach(revision.run.result) } }
            : revision,
        ),
      ),
  ]);
  return { ...session, run, ...(history && { history }) };
}

export async function fetchSession(id: string) {
  return hydrateSession(await api<ReviewSession>(`/sessions/${id}`));
}
