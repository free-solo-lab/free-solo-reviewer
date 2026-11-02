import React from 'react';
import { it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '../web/ui/Tooltip';
import { App } from '../web/App';
afterEach(() => vi.unstubAllGlobals());
it('renders the complete initial workspace before any review is selected', () => {
  vi.stubGlobal('window', {
    location: { search: '', pathname: '/' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const markup = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(MemoryRouter, null, React.createElement(App)),
      ),
    ),
  );
  expect(markup).toContain('app-shell');
  client.clear();
});
it('shows a recoverable error instead of an empty root', async () => {
  const { StartupFailure } = await import('../web/Startup');
  const markup = renderToStaticMarkup(
    React.createElement(StartupFailure, { error: new Error('Missing view') }),
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Перезагрузить приложение');
  expect(markup).toContain('Missing view');
});
it('revalidates the HTML shell while preserving API cache rules', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../server/app');
  const root = await mkdtemp(join(tmpdir(), 'reviewer-shell-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><div id="root">Reviewer</div>');
  const { app } = createApp({ dataDir: join(root, 'data'), webDir: root });
  try {
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-cache');
    const status = await app.inject({ method: 'GET', url: '/api/settings/language' });
    expect(status.headers['cache-control']).not.toBe('no-cache');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
