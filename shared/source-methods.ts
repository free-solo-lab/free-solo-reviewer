import type { SourceDiffRow } from './source-diff.js';
import type { MethodView } from './viewed-methods.js';

/** Opposite-side diff lines belong to the next native line's method, not a separate block. */
export function sourceMethodRows(rows: SourceDiffRow[], methods: MethodView[]) {
  let nextLine = rows.filter((row) => row.native).at(-1)?.evidence.startLine ?? 0;
  const ordered = [...methods].sort(
    (a, b) => a.method.evidence.startLine - b.method.evidence.startLine,
  );
  return rows
    .map((row) => ({ row, method: undefined as MethodView | undefined, methodStart: false }))
    .reverse()
    .map((entry) => {
      if (entry.row.native) nextLine = entry.row.evidence.startLine;
      const candidate = ordered.find(
        ({ method }) =>
          nextLine >= method.evidence.startLine && nextLine <= method.evidence.endLine,
      );
      const method =
        entry.row.historical && nextLine === candidate?.method.evidence.startLine
          ? undefined
          : candidate;
      return {
        ...entry,
        method,
        methodStart: !!method && entry.row.native && nextLine === method.method.evidence.startLine,
      };
    })
    .reverse();
}
