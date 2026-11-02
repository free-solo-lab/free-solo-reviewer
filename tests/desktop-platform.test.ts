import { afterEach, expect, it, vi } from 'vitest';
import { isInternalUrl, externalUrl } from '../desktop/navigation';
import { chooseRepositoryDirectory, platform } from '../web/platform';
import { toolEnvironment } from '../desktop/service-controller';
afterEach(() => vi.unstubAllGlobals());
it('keeps web and native directory selection behind the same adapter', async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ path: '/repo/browser' }))),
  );
  expect(platform()).toBe('browser');
  expect(await chooseRepositoryDirectory()).toBe('/repo/browser');
  const chooseDirectory = vi.fn(async () => '/repo/native');
  vi.stubGlobal('window', { reviewerDesktop: { platform: 'desktop', chooseDirectory } });
  expect(platform()).toBe('desktop');
  expect(await chooseRepositoryDirectory()).toBe('/repo/native');
  expect(chooseDirectory).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('allows only the service origin in the desktop window and safe external links', () => {
  expect(isInternalUrl('http://127.0.0.1:4318/settings/prompts', 'http://127.0.0.1:4318')).toBe(
    true,
  );
  for (const url of [
    'https://evil.example',
    'http://127.0.0.1:4319',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])
    expect(isInternalUrl(url, 'http://127.0.0.1:4318')).toBe(false);
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hello',
    'https://user:pass@example.org',
  ])
    expect(externalUrl(url)).toBeUndefined();
  expect(externalUrl('https://github.com/team/repo')).toBe('https://github.com/team/repo');
});
it('finds tools when launched from Finder without replacing the user home or credentials', () => {
  const result = toolEnvironment(
    { PATH: '/usr/bin', HOME: '/user', CODEX_HOME: '/user/.codex' },
    '/app/runtime/node',
    '/user',
  );
  expect(result.PATH?.split(':')[0]).toBe('/app/runtime');
  expect(result.PATH).toContain('/opt/homebrew/bin');
  expect(result.HOME).toBe('/user');
  expect(result.CODEX_HOME).toBe('/user/.codex');
});
