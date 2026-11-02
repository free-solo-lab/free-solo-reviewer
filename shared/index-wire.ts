import type { Evidence, SourceIndex } from './model.js';

/**
 * A source index on its way to the browser. Every evidence repeated the index's repository and
 * side, and every call site its method's file, which made an index of a large service over 10 MB.
 * Here a line range in the same file is `[startLine, endLine]` and one in another file of the same
 * repository and side is `[path, startLine, endLine]`; anything else stays a full evidence.
 */
export const INDEX_WIRE = 'compact-1';
type WireEvidence = Evidence | [number, number] | [string, number, number];
interface Place {
  repoId: string;
  side: Evidence['side'];
  path?: string;
}

function pack(evidence: Evidence, place: Place): WireEvidence {
  if (evidence.repoId !== place.repoId || evidence.side !== place.side) return evidence;
  return evidence.path === place.path
    ? [evidence.startLine, evidence.endLine]
    : [evidence.path, evidence.startLine, evidence.endLine];
}
function unpack(value: WireEvidence, place: Place): Evidence {
  if (!Array.isArray(value)) return value;
  return value.length === 2
    ? {
        repoId: place.repoId,
        side: place.side,
        path: place.path!,
        startLine: value[0],
        endLine: value[1],
      }
    : {
        repoId: place.repoId,
        side: place.side,
        path: value[0],
        startLine: value[1],
        endLine: value[2],
      };
}
/** Rewrites every evidence of an index, giving each the place it is relative to. */
function mapEvidence<From, To>(
  index: SourceIndex,
  convert: (value: From, place: Place) => To,
  pathOf: (value: From | To) => string,
) {
  const place = { repoId: index.repoId, side: index.side };
  const at = (value: unknown, path?: string) => convert(value as From, { ...place, path });
  return {
    ...index,
    types: index.types?.map((type) => ({ ...type, evidence: at(type.evidence) })),
    methods: index.methods.map((method) => {
      const evidence = at(method.evidence);
      const path = pathOf(evidence as From | To);
      return {
        ...method,
        evidence,
        ...(method.callSites && {
          callSites: method.callSites.map((call) => ({
            ...call,
            evidence: at(call.evidence, path),
          })),
        }),
        ...(method.programmaticTransactions && {
          programmaticTransactions: method.programmaticTransactions.map((transaction) => ({
            ...transaction,
            evidence: at(transaction.evidence, path),
          })),
        }),
      };
    }),
  };
}
const pathOf = (value: unknown) =>
  Array.isArray(value)
    ? value.length === 3
      ? (value[0] as string)
      : ''
    : (value as Evidence).path;

export function packIndex(index: SourceIndex) {
  return { ...mapEvidence<Evidence, WireEvidence>(index, pack, pathOf), wire: INDEX_WIRE };
}
export function unpackIndex(value: SourceIndex & { wire?: string }): SourceIndex {
  if (value.wire !== INDEX_WIRE) return value;
  const { wire: _wire, ...index } = value;
  return mapEvidence<WireEvidence, Evidence>(index, unpack, pathOf) as SourceIndex;
}
