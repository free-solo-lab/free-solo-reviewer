import { useWorkspace } from '../workspace/state';
import { t } from '../../shared/i18n';

export function WelcomePage() {
  const { status, setSetup } = useWorkspace();
  return (
    <section className="welcome">
      <div className="eyebrow">{t('UNDERSTAND CHANGES AS A WHOLE')}</div>
      <h1>
        {t('From lines of code')}
        <br />
        {t('to system behavior.')}
      </h1>
      <p>{t('Open a PR, trace calls between services and review with the full context.')}</p>
      <button className="primary" onClick={() => setSetup(true)}>
        {t('Create your first review')} <span>↗</span>
      </button>
      <div className="welcome-grid">
        {[
          ['01', t('Connect the code'), t('Local repositories and pull requests from GitHub.')],
          [
            '02',
            t('Explore the changes'),
            t('Diagrams, contracts, SQL and tests linked to the code.'),
          ],
          [
            '03',
            t('Send the review'),
            t('Check the remarks and publish your decision under your name.'),
          ],
        ].map(([n, t, p]) => (
          <article key={n}>
            <span>{n}</span>
            <h3>{t}</h3>
            <p>{p}</p>
          </article>
        ))}
      </div>
      <div className="connection-note">
        <span>⌁</span> {t('Codex analyzes the provided context. Source code is never run.')}
      </div>
      {status?.githubError && <p className="connection-error">GitHub: {status.githubError}</p>}
    </section>
  );
}
