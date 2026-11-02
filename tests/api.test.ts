import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/api';

const respond = (status: number, text: string) =>
  vi.stubGlobal('fetch', async () => new Response(text, { status }));
afterEach(() => vi.unstubAllGlobals());

describe('web API client', () => {
  it('returns parsed JSON and the server error message', async () => {
    respond(200, '{"ok":true}');
    await expect(api('/health')).resolves.toEqual({ ok: true });
    respond(409, '{"error":"Анализ уже запущен."}');
    await expect(api('/x', 'POST', {})).rejects.toThrow('Анализ уже запущен.');
  });

  it('reports the HTTP status when an error body is not JSON', async () => {
    respond(502, '<html>Bad Gateway</html>');
    await expect(api('/x')).rejects.toThrow('HTTP 502');
  });

  it('rejects a successful response that is not JSON', async () => {
    respond(200, '<html></html>');
    await expect(api('/x')).rejects.toThrow('не в формате JSON');
  });
});
