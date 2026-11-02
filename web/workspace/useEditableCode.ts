import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CodeCaret } from './code-buffer';
import {
  domToModel,
  indentRange,
  modelSelection,
  placeSelection,
  rangeText,
  replaceRange,
  step,
  visibleText,
  type CodePosition,
} from './editable-code';

export interface InlineEditing {
  chunks: string[];
  onEdit: (chunks: string[], caret: CodeCaret) => void;
  onSave: () => void;
  /** Returns where the caret was at that version. */
  onUndo?: (redo: boolean) => CodeCaret | undefined;
}
const caretAt = (caret: CodeCaret): CodePosition => ({ line: caret.line, offset: caret.start });

/**
 * Makes the code column one editor: selection, copy and paste work across lines like in an IDE,
 * while every change goes through the line model so the diff and its comments stay anchored.
 * Returns a counter that changes when the text of the page was replaced by the browser (IME).
 */
export function useEditableCode(root: RefObject<HTMLDivElement | null>, editing?: InlineEditing) {
  const latest = useRef(editing);
  latest.current = editing;
  const pending = useRef<{ from: CodePosition; to: CodePosition } | null>(null);
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    const element = root.current,
      target = pending.current;
    if (!element || !target) return;
    pending.current = null;
    element.focus({ preventScroll: true });
    placeSelection(element, target.from, target.to);
  }, [editing?.chunks, generation]);
  const enabled = !!editing;
  useEffect(() => {
    const element = root.current;
    if (!element || !enabled) return;
    const apply = (chunks: string[], from: CodePosition, to: CodePosition = from) => {
      pending.current = { from, to };
      latest.current?.onEdit(chunks, { line: from.line, start: from.offset, end: from.offset });
    };
    const replace = (text: string, from: CodePosition, to: CodePosition) => {
      const current = latest.current;
      if (!current) return;
      const result = replaceRange(current.chunks, from, to, text);
      apply(result.chunks, caretAt(result.caret));
    };
    const undo = (redo: boolean) => {
      const caret = latest.current?.onUndo?.(redo);
      if (caret) pending.current = { from: caretAt(caret), to: caretAt(caret) };
    };
    const onBeforeInput = (event: InputEvent) => {
      // Fields inside the code (comment forms, replies) edit themselves.
      if (event.target !== element || event.isComposing) return;
      const current = latest.current;
      if (!current) return;
      const type = event.inputType;
      if (type === 'insertCompositionText') return;
      event.preventDefault();
      if (type === 'historyUndo' || type === 'historyRedo') return undo(type === 'historyRedo');
      const selection = modelSelection(element);
      if (!selection) return;
      const { from, to } = selection;
      if (type === 'insertText' || type === 'insertReplacementText')
        return replace(event.data ?? event.dataTransfer?.getData('text/plain') ?? '', from, to);
      if (type === 'insertParagraph' || type === 'insertLineBreak') {
        // A new line keeps the indentation of the one it is split from.
        const text = visibleText(current.chunks[from.line - 1] ?? '').slice(0, from.offset);
        const indent = text.slice(text.lastIndexOf('\n') + 1).match(/^[ \t]*/)![0];
        return replace(`\n${indent}`, from, to);
      }
      if (type.startsWith('insertFrom')) {
        // Pastes arrive through the paste event below; a browser that skips it may also send no
        // data here. Without text nothing changes, so a selection is never silently dropped.
        const text = (event.dataTransfer?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
        if (text) replace(text, from, to);
        return;
      }
      if (type.startsWith('delete')) {
        if (!selection.collapsed) return replace('', from, to);
        // Word and line deletions: the browser tells which range it would remove.
        const target = event.getTargetRanges()[0];
        const start = target && domToModel(element, target.startContainer, target.startOffset, 1);
        const end = target && domToModel(element, target.endContainer, target.endOffset, -1);
        if (start && end && (start.line !== end.line || start.offset !== end.offset))
          return replace('', start, end);
        const backward = type.includes('Backward');
        return replace(
          '',
          backward ? step(current.chunks, from, -1) : from,
          backward ? from : step(current.chunks, from, 1),
        );
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== element || event.isComposing) return;
      const current = latest.current;
      if (!current) return;
      const key = event.key.toLowerCase();
      const command = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (command && key === 's') {
        event.preventDefault();
        current.onSave();
      } else if (command && (key === 'z' || (key === 'y' && event.ctrlKey))) {
        event.preventDefault();
        undo(key === 'y' || event.shiftKey);
      } else if (command && key === 'a') {
        // All of the code, not the comments and headers around it.
        event.preventDefault();
        const lines = [...element.querySelectorAll<HTMLElement>('[data-edit-line]')];
        if (!lines.length) return;
        const last = lines.at(-1)!;
        placeSelection(
          element,
          { line: Number(lines[0].dataset.editLine), offset: 0 },
          { line: Number(last.dataset.editLine), offset: last.textContent?.length ?? 0 },
        );
      } else if (key === 'tab' && !command) {
        event.preventDefault();
        const selection = modelSelection(element);
        if (!selection) return;
        const { from, to } = selection;
        if (selection.collapsed && !event.shiftKey) return replace('    ', from, to);
        const chunks = indentRange(current.chunks, from, to, event.shiftKey);
        const length = (line: number) => visibleText(chunks[line - 1] ?? '').length;
        apply(chunks, { line: from.line, offset: 0 }, { line: to.line, offset: length(to.line) });
      }
    };
    const copy = (event: ClipboardEvent, cut: boolean) => {
      const current = latest.current;
      const selection = current && modelSelection(element);
      if (!current || !selection || selection.collapsed || !event.clipboardData) return;
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
        return;
      // Only the code: no line numbers, removed lines or comments in between.
      event.clipboardData.setData(
        'text/plain',
        rangeText(current.chunks, selection.from, selection.to),
      );
      event.preventDefault();
      if (cut) replace('', selection.from, selection.to);
    };
    const onCopy = (event: ClipboardEvent) => copy(event, false);
    const onCut = (event: ClipboardEvent) => copy(event, true);
    // The clipboard text is always available in the paste event, unlike in beforeinput.
    const onPaste = (event: ClipboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
        return;
      const selection = latest.current && modelSelection(element);
      if (!selection || !event.clipboardData) return;
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
      if (text) replace(text, selection.from, selection.to);
    };
    // Composed input (accents, Asian scripts) is typed by the browser; take its result after.
    const onCompositionEnd = (event: CompositionEvent) => {
      const current = latest.current;
      const span = (event.target instanceof Element ? event.target : null)?.ownerDocument
        .getSelection()
        ?.anchorNode?.parentElement?.closest<HTMLElement>('[data-edit-line]');
      if (!current || !span || !element.contains(span)) return;
      const line = Number(span.dataset.editLine);
      const old = current.chunks[line - 1] ?? '';
      const text = span.textContent ?? '';
      const selection = modelSelection(element);
      const chunks = current.chunks.map((chunk, i) =>
        i === line - 1 ? text + old.slice(visibleText(old).length) : chunk,
      );
      setGeneration((value) => value + 1);
      apply(chunks, selection?.from ?? { line, offset: text.length });
    };
    const noDrag = (event: DragEvent) => event.preventDefault();
    element.addEventListener('beforeinput', onBeforeInput);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('copy', onCopy);
    element.addEventListener('cut', onCut);
    element.addEventListener('paste', onPaste);
    element.addEventListener('compositionend', onCompositionEnd);
    element.addEventListener('dragstart', noDrag);
    element.addEventListener('drop', noDrag);
    return () => {
      element.removeEventListener('beforeinput', onBeforeInput);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('copy', onCopy);
      element.removeEventListener('cut', onCut);
      element.removeEventListener('paste', onPaste);
      element.removeEventListener('compositionend', onCompositionEnd);
      element.removeEventListener('dragstart', noDrag);
      element.removeEventListener('drop', noDrag);
    };
  }, [enabled, root]);
  return generation;
}
