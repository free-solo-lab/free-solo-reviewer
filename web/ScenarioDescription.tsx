import { Markdown } from './Markdown';
import type { ScenarioChange } from '../shared/scenario-changes';
import { reviewDescription } from '../shared/review-description';
import { t } from '../shared/i18n';
export function ScenarioDescription({
  summary,
  change,
}: {
  summary: string;
  change?: ScenarioChange;
}) {
  const text = reviewDescription(summary, 'scenario');
  const oldBlocks = new Set(
    change?.previous ? reviewDescription(change.previous.summary, 'scenario').split(/\n\s*\n/) : [],
  );
  return (
    <div className="scenario-revision-description">
      {change && (
        <div className="scenario-revision-note">
          {change.kind === 'added'
            ? t('New scenario since the last review')
            : t('Changes since the last review are highlighted')}{' '}
          · +{[...change.steps.values()].filter((value) => value === 'added').length} {t('calls ·')}{' '}
          {change.steps.size -
            [...change.steps.values()].filter((value) => value === 'added').length}{' '}
          {t('changed · −')}
          {change.removed.length}
        </div>
      )}
      {change ? (
        text.split(/\n\s*\n/).map((block, i) => (
          <div key={i} className={!oldBlocks.has(block) ? 'scenario-revision-block' : undefined}>
            <Markdown>{block}</Markdown>
          </div>
        ))
      ) : (
        <Markdown>{text}</Markdown>
      )}
      {!!change?.removed.length && (
        <div className="scenario-removed-calls">
          <strong>{t('Removed since the last review')}</strong>
          <ul>
            {change.removed.map((step) => (
              <li key={step.id}>{step.label}</li>
            ))}
          </ul>
        </div>
      )}
      {change?.previous && change.previous.summary !== summary && (
        <details className="scenario-before-description">
          <summary>{t('Description before the fixes')}</summary>
          <Markdown>{reviewDescription(change.previous.summary, 'scenario')}</Markdown>
        </details>
      )}
    </div>
  );
}
