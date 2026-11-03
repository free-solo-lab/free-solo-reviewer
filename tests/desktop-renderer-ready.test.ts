import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { waitForRendererReady } from '../desktop/renderer-ready';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function renderer(initial: string[] = []) {
  const elements = new Set(initial);
  let changed!: () => void;
  const disconnect = vi.fn();
  const ready = runInNewContext(`(${waitForRendererReady.toString()})()`, {
    document: {
      documentElement: {},
      querySelector: (selector: string) =>
        elements.has(selector) ? { childElementCount: 1 } : null,
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        changed = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
    setTimeout,
    clearTimeout,
  }) as Promise<void>;
  return { ready, elements, changed, disconnect };
}

it('accepts an already rendered application shell and clears its resources', async () => {
  const f = renderer(['#root .app-shell']);
  await f.ready;
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for the shell instead of accepting arbitrary children of the React root', async () => {
  const f = renderer(['#root']);
  const settled = vi.fn();
  void f.ready.then(settled);
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).not.toHaveBeenCalled();
  f.elements.add('#root .app-shell');
  f.changed();
  await f.ready;
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects the startup error screen even if other app markup is present', async () => {
  const f = renderer(['#root .app-shell', '#root .startup-screen[role="alert"]']);
  await expect(f.ready).rejects.toThrow('UI failed to start');
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects an error boundary fallback rendered after the initial document', async () => {
  const f = renderer();
  f.elements.add('#root .startup-screen[role="alert"]');
  f.changed();
  await expect(f.ready).rejects.toThrow('UI failed to start');
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('times out an empty interface after ten seconds and disconnects the observer', async () => {
  const f = renderer();
  const result = f.ready.catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toMatchObject({ message: 'Reviewer UI did not become ready' });
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
