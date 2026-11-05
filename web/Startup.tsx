import React from 'react';
import { t } from '../shared/i18n';
import { errorMessage } from '../shared/errors';
import { reportClientError } from './client-log';

export function StartupFailure({ error }: { error: unknown }) {
  return (
    <section className="startup-screen" role="alert">
      <h1>{t('Could not load Reviewer.')}</h1>
      <p>{t('Saved reviews and comments remain available.')}</p>
      <button onClick={() => window.location.reload()}>{t('Reload application')}</button>
      <details>
        <summary>{t('Details')}</summary>
        <pre>{errorMessage(error)}</pre>
      </details>
    </section>
  );
}
export class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportClientError(
      `Interface error: ${error.message}`,
      [error.stack, info.componentStack].filter(Boolean).join('\n'),
    );
  }
  render() {
    return this.state.error ? <StartupFailure error={this.state.error} /> : this.props.children;
  }
}
