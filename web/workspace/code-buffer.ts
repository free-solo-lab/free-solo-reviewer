import { errorMessage } from '../../shared/errors';
export interface CodeCaret {
  line: number;
  start: number;
  end: number;
}
export interface CodeBufferState {
  chunks: string[];
  saved: string;
  hash: string;
  saving: boolean;
  error: string;
}
interface EditVersion {
  chunks: string[];
  caret?: CodeCaret;
}

/** A working file, with its own undo history and serialized, debounced writes. */
export class CodeBuffer {
  private state: CodeBufferState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | null = null;
  private past: EditVersion[] = [];
  private future: EditVersion[] = [];
  private caret?: CodeCaret;
  constructor(
    chunks: string[],
    hash: string,
    private write: (content: string, hash: string) => Promise<{ hash: string }>,
    private delay = 200,
  ) {
    this.state = { chunks, saved: chunks.join(''), hash, saving: false, error: '' };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get dirty() {
    return this.state.chunks.join('') !== this.state.saved;
  }
  private update(value: Partial<CodeBufferState>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.dirty && !this.state.error)
      this.timer = setTimeout(() => void this.flush(), this.delay);
  }
  change(chunks: string[], caret?: CodeCaret) {
    if (chunks.join('') === this.state.chunks.join('')) return;
    const changed = chunks.findIndex((chunk, i) => chunk !== this.state.chunks[i]);
    const old = this.state.chunks[changed] ?? '',
      next = chunks[changed] ?? '';
    let prefix = 0;
    while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) prefix++;
    const before = {
      line: changed + 1,
      start: prefix + Math.max(0, old.length - next.length),
      end: prefix + Math.max(0, old.length - next.length),
    };
    this.past.push({ chunks: this.state.chunks, caret: before });
    this.past = this.past.slice(-200);
    this.future = [];
    this.caret = caret;
    this.update({ chunks });
    this.schedule();
  }
  undo(redo = false): CodeCaret | undefined {
    const from = redo ? this.future : this.past,
      to = redo ? this.past : this.future;
    const version = from.pop();
    if (!version) return;
    to.push({ chunks: this.state.chunks, caret: this.caret });
    this.caret = version.caret;
    this.update({ chunks: version.chunks });
    this.schedule();
    return version.caret;
  }
  flush = (retry = false): Promise<void> => {
    clearTimeout(this.timer);
    if (retry && this.state.error) this.update({ error: '' });
    if (this.writing) return this.writing;
    if (!this.dirty || this.state.error) return Promise.resolve();
    this.writing = (async () => {
      this.update({ saving: true });
      try {
        // Edits and undo can arrive during a save. Finish it, then write the latest version
        // with the returned hash; two saves of this file never race each other.
        while (this.dirty) {
          const content = this.state.chunks.join('');
          const { hash } = await this.write(content, this.state.hash);
          this.update({ saved: content, hash });
        }
      } catch (error) {
        this.update({ error: errorMessage(error) });
      } finally {
        this.update({ saving: false });
      }
    })().finally(() => {
      this.writing = null;
    });
    return this.writing;
  };
}

export const codeBuffers = new Map<string, CodeBuffer>();
export const hasPendingCode = () =>
  [...codeBuffers.values()].some((buffer) => buffer.dirty || buffer.getSnapshot().saving);
export const flushCodeBuffers = () =>
  Promise.all([...codeBuffers.values()].map((buffer) => buffer.flush()));
