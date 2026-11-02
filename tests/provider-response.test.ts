import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { readAnalysisResponse } from '../server/provider.js';

async function* stream(...events: ThreadEvent[]) {
  yield* events;
}
const message = (text: string): ThreadEvent => ({
  type: 'item.completed',
  item: { id: 'm', type: 'agent_message', text },
});
const live = () => new AbortController().signal;

describe('Codex analysis response', () => {
  it('returns the parsed final agent message', async () => {
    await expect(
      readAnalysisResponse(stream(message('{"a":1}'), message('{"b":2}')), live(), live()),
    ).resolves.toEqual({ b: 2 });
  });

  it('explains an empty or non-JSON answer instead of a parser error', async () => {
    await expect(readAnalysisResponse(stream(), live(), live())).rejects.toThrow(
      'не вернув результат',
    );
    await expect(readAnalysisResponse(stream(message('not json')), live(), live())).rejects.toThrow(
      'не в формате JSON',
    );
  });

  it('reports the time limit when only the timeout fired', async () => {
    const timeout = AbortSignal.abort();
    async function* hung(): AsyncGenerator<ThreadEvent> {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    await expect(readAnalysisResponse(hung(), live(), timeout)).rejects.toThrow('не ответил за 10');
  });

  it('keeps a user cancellation as a cancellation', async () => {
    const user = AbortSignal.abort();
    await expect(readAnalysisResponse(stream(message('{}')), user, user)).rejects.toThrow(
      'aborted',
    );
  });

  it('allows local read commands only when explicitly enabled, while still rejecting file changes', async () => {
    const command = {
      type: 'item.started',
      item: { id: 'read', type: 'command_execution', command: 'rg find repo-1/head' },
    } as ThreadEvent;
    await expect(
      readAnalysisResponse(stream(command, message('{}')), live(), live(), true),
    ).resolves.toEqual({});
    const change = {
      type: 'item.completed',
      item: { id: 'write', type: 'file_change', changes: [], status: 'completed' },
    } as ThreadEvent;
    await expect(readAnalysisResponse(stream(change), live(), live(), true)).rejects.toThrow(
      'инструмент',
    );
  });

  it('stops when the model tries to use a tool', async () => {
    const tool = {
      type: 'item.started',
      item: { id: 't', type: 'command_execution' },
    } as unknown as ThreadEvent;
    await expect(readAnalysisResponse(stream(tool), live(), live())).rejects.toThrow('инструмент');
  });
});
