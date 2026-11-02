import type { CodeCaret } from './code-buffer';

/**
 * The code column is one editing surface over the diff. Each current line of the review is a
 * span `[data-edit-line]` holding that line's text, which may grow to several lines while
 * editing. Positions are (line, offset in that text); every edit goes through the model.
 */
export interface CodePosition {
  line: number;
  offset: number;
}
const EDIT = '[data-edit-line]';
const ending = (chunk: string) =>
  chunk.endsWith('\r\n') ? '\r\n' : chunk.endsWith('\n') ? '\n' : '';
/** The text of a line without the line break that separates it from the next one. */
export const visibleText = (chunk: string) => chunk.slice(0, chunk.length - ending(chunk).length);

const before = (a: CodePosition, b: CodePosition) =>
  a.line < b.line || (a.line === b.line && a.offset < b.offset);
export const ordered = (a: CodePosition, b: CodePosition): [CodePosition, CodePosition] =>
  before(b, a) ? [b, a] : [a, b];

/** Replaces the text between two positions; lines in between join the first one. */
export function replaceRange(
  chunks: string[],
  from: CodePosition,
  to: CodePosition,
  text: string,
): { chunks: string[]; caret: CodeCaret } {
  const [a, b] = ordered(from, to);
  const head = visibleText(chunks[a.line - 1] ?? '').slice(0, a.offset);
  const last = chunks[b.line - 1] ?? '';
  const next = chunks.map((chunk, i) =>
    i === a.line - 1
      ? head + text + visibleText(last).slice(b.offset) + ending(last)
      : i > a.line - 1 && i <= b.line - 1
        ? ''
        : chunk,
  );
  const at = head.length + text.length;
  return { chunks: next, caret: { line: a.line, start: at, end: at } };
}

export function rangeText(chunks: string[], from: CodePosition, to: CodePosition) {
  const [a, b] = ordered(from, to);
  if (a.line === b.line) return visibleText(chunks[a.line - 1] ?? '').slice(a.offset, b.offset);
  const first = chunks[a.line - 1] ?? '';
  return [
    visibleText(first).slice(a.offset) + ending(first),
    ...chunks.slice(a.line, b.line - 1),
    visibleText(chunks[b.line - 1] ?? '').slice(0, b.offset),
  ].join('');
}

/** The neighbouring position for Backspace or Delete, across hidden (joined) lines. */
export function step(chunks: string[], at: CodePosition, direction: -1 | 1): CodePosition {
  const text = visibleText(chunks[at.line - 1] ?? '');
  if (direction === -1 && at.offset > 0) return { line: at.line, offset: at.offset - 1 };
  if (direction === 1 && at.offset < text.length) return { line: at.line, offset: at.offset + 1 };
  for (let i = at.line - 1 + direction; i >= 0 && i < chunks.length; i += direction)
    if (chunks[i])
      return { line: i + 1, offset: direction === -1 ? visibleText(chunks[i]).length : 0 };
  return at;
}

/** Adds or removes one indent on every line touched by the selection, keeping line anchors. */
export function indentRange(
  chunks: string[],
  from: CodePosition,
  to: CodePosition,
  outdent: boolean,
): string[] {
  const [a, b] = ordered(from, to);
  return chunks.map((chunk, i) => {
    const line = i + 1;
    if (line < a.line || line > b.line || !chunk) return chunk;
    const text = visibleText(chunk);
    let offset = 0;
    const lines = text.split('\n').map((row) => {
      const start = offset;
      offset += row.length + 1;
      const touched =
        (line > a.line || start + row.length >= a.offset) && (line < b.line || start <= b.offset);
      if (!touched) return row;
      return outdent ? row.replace(/^( {1,4}|\t)/, '') : `    ${row}`;
    });
    return lines.join('\n') + ending(chunk);
  });
}

/** The position of a DOM point, or the nearest editable position in the given direction. */
export function domToModel(
  root: HTMLElement,
  node: Node,
  offset: number,
  direction: -1 | 1 = 1,
): CodePosition | null {
  const element = node instanceof Element ? node : node.parentElement;
  const span = element?.closest<HTMLElement>(EDIT);
  if (span && root.contains(span)) {
    const range = document.createRange();
    range.selectNodeContents(span);
    range.setEnd(node, offset);
    // A <br> placeholder of an empty line has no text and counts as nothing.
    return { line: Number(span.dataset.editLine), offset: range.toString().length };
  }
  // A point in a comment, a removed line or a gutter: the closest editable line around it.
  const spans = [...root.querySelectorAll<HTMLElement>(EDIT)];
  const point = document.createRange();
  point.setStart(node, offset);
  point.collapse(true);
  if (direction === 1) {
    const next = spans.find((item) => point.comparePoint(item, 0) >= 0);
    return next ? { line: Number(next.dataset.editLine), offset: 0 } : null;
  }
  const previous = spans.findLast((item) => point.comparePoint(item, item.childNodes.length) <= 0);
  return previous
    ? { line: Number(previous.dataset.editLine), offset: textOf(previous).length }
    : null;
}
const textOf = (span: HTMLElement) => span.textContent ?? '';

function modelToDom(root: HTMLElement, at: CodePosition): [Node, number] | null {
  const span = root.querySelector<HTMLElement>(`[data-edit-line="${at.line}"]`);
  if (!span) return null;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let left = at.offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (left <= length) return [node, left];
    left -= length;
  }
  return [
    span,
    span.childNodes.length && span.lastChild?.nodeName === 'BR' ? 0 : span.childNodes.length,
  ];
}

export function placeSelection(root: HTMLElement, from: CodePosition, to: CodePosition = from) {
  const start = modelToDom(root, from),
    end = modelToDom(root, to);
  const selection = window.getSelection();
  if (!start || !end || !selection) return;
  selection.setBaseAndExtent(start[0], start[1], end[0], end[1]);
}

/** The current selection in model terms, if it lies in this code column. */
export function modelSelection(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !root.contains(selection.anchorNode))
    return null;
  const range = selection.getRangeAt(0);
  const from = domToModel(root, range.startContainer, range.startOffset, 1),
    to = domToModel(root, range.endContainer, range.endOffset, -1);
  if (!from || !to) return null;
  return { from, to: before(to, from) ? from : to, collapsed: range.collapsed };
}
