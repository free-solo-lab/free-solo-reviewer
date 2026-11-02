// Global styles first: component modules loaded after them may refine shared classes.
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/cyrillic-400.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/cyrillic-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/cyrillic-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queries';
import { TooltipProvider } from './ui/Tooltip';
import { AppErrorBoundary, StartupFailure } from './Startup';
import { isLanguage, setLanguage } from '../shared/i18n';

/** The language is set before the interface loads, so every text renders in it at once. */
async function start() {
  const settings = await fetch('/api/settings/language', { signal: AbortSignal.timeout(5000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined);
  if (isLanguage(settings?.language)) setLanguage(settings.language);
  document.documentElement.lang = settings?.language ?? 'en';
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <BrowserRouter>
              <Routes>
                <Route path="*" element={<App />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </QueryClientProvider>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}
void start().catch((error) => {
  createRoot(document.getElementById('root')!).render(<StartupFailure error={error} />);
});
