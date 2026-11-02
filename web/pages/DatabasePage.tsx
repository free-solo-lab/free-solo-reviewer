import { DatabaseSchemaView } from '../DatabaseSchema';
import { useWorkspace } from '../workspace/state';
import { CodeFlow } from './ScenarioCode';
import { t } from '../../shared/i18n';

export function DatabasePage() {
  const { sessionData, session, openSource, scenarioView, setScenarioView } = useWorkspace();
  if (!session) return null;
  return (
    <DatabaseSchemaView
      sessionId={sessionData!.id}
      snapshots={session.snapshots}
      onSource={(ref) => {
        void openSource(ref);
      }}
      view={scenarioView === 'diagram' ? 'diagram' : 'code'}
      onView={setScenarioView}
      code={(migrations) => (
        <CodeFlow
          key={migrations
            .map((migration) => `${migration.evidence.repoId}:${migration.path}`)
            .join()}
          entries={() =>
            migrations.map((migration) => ({
              id: `${migration.evidence.repoId}:${migration.evidence.side}:${migration.path}`,
              label: migration.name,
              evidence: migration.evidence,
              ranges: [migration.evidence],
            }))
          }
          dependency={migrations}
          loading={t('Loading SQL scripts…')}
          empty={t('This PR version has no changed SQL migrations.')}
        />
      )}
    />
  );
}
