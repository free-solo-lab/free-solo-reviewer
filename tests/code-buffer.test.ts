import { afterEach, expect, it, vi } from 'vitest';
import { CodeBuffer } from '../web/workspace/code-buffer';

afterEach(() => vi.useRealTimers());
it('autosaves the latest text without a save button and uses the returned hash for later edits', async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => ({ hash: 'h2' }));
  const buffer = new CodeBuffer(['old\n'], 'h1', write);
  buffer.change(['o\n']);
  buffer.change(['new\n']);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith('new\n', 'h1');
  expect(buffer.dirty).toBe(false);
  buffer.change(['next\n']);
  await buffer.flush();
  expect(write).toHaveBeenLastCalledWith('next\n', 'h2');
});
it('serializes saves and keeps newer typing or undo while a request is in flight', async () => {
  let resolve!: (value: { hash: string }) => void;
  const write = vi
    .fn<(content: string, hash: string) => Promise<{ hash: string }>>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ hash: 'h3' });
  const buffer = new CodeBuffer(['old\n'], 'h1', write);
  buffer.change(['first\n']);
  const saving = buffer.flush();
  buffer.change(['second\n']);
  expect(write).toHaveBeenCalledTimes(1);
  resolve({ hash: 'h2' });
  await saving;
  expect(write.mock.calls).toEqual([
    ['first\n', 'h1'],
    ['second\n', 'h2'],
  ]);
  buffer.undo();
  await buffer.flush();
  expect(write).toHaveBeenLastCalledWith('first\n', 'h3');
  buffer.undo();
  await buffer.flush();
  expect(write).toHaveBeenLastCalledWith('old\n', 'h3');
  buffer.undo(true);
  await buffer.flush();
  expect(write).toHaveBeenLastCalledWith('first\n', 'h3');
});
it('undoes changes across rows, indentation, joins and multiline paste after autosave', async () => {
  const write = vi.fn(async () => ({ hash: 'saved' }));
  const original = ['first\n', 'second\n'];
  const buffer = new CodeBuffer(original, 'initial', write);
  buffer.change(['    first\n', 'second\n'], { line: 1, start: 4, end: 4 });
  await buffer.flush();
  buffer.change(['    firstsecond\n', ''], { line: 1, start: 9, end: 9 });
  await buffer.flush();
  buffer.change(['paste\nmultiple\nlines\n', '']);
  await buffer.flush();
  buffer.undo();
  buffer.undo();
  buffer.undo();
  await buffer.flush();
  expect(buffer.getSnapshot().chunks).toEqual(original);
  expect(write).toHaveBeenLastCalledWith(original.join(''), 'saved');
});
it('saves an undo that arrived before an earlier write finished', async () => {
  let resolve!: (value: { hash: string }) => void;
  const write = vi
    .fn<(content: string, hash: string) => Promise<{ hash: string }>>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ hash: 'h3' });
  const buffer = new CodeBuffer(['original'], 'h1', write);
  buffer.change(['edit']);
  const saving = buffer.flush();
  buffer.undo();
  resolve({ hash: 'h2' });
  await saving;
  expect(write.mock.calls).toEqual([
    ['edit', 'h1'],
    ['original', 'h2'],
  ]);
  expect(buffer.dirty).toBe(false);
});
it('retains unsaved text and stops automatic retries after a conflict or failed save', async () => {
  vi.useFakeTimers();
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error('External edit'))
    .mockResolvedValue({ hash: 'h2' });
  const buffer = new CodeBuffer(['original'], 'h1', write);
  buffer.change(['mine']);
  await buffer.flush();
  expect(buffer.getSnapshot().error).toBe('External edit');
  expect(buffer.dirty).toBe(true);
  expect(buffer.getSnapshot().chunks).toEqual(['mine']);
  buffer.change(['latest']);
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledTimes(1);
  await buffer.flush(true);
  expect(write).toHaveBeenLastCalledWith('latest', 'h1');
  expect(buffer.dirty).toBe(false);
  expect(buffer.getSnapshot().error).toBe('');
});
