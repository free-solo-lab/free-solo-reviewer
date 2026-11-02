import { Markdown } from './Markdown';
import type { ScenarioChange } from '../shared/scenario-changes';
import { reviewDescription } from '../shared/review-description';
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
            ? 'Новый сценарий после прошлого ревью'
            : 'Изменения после прошлого ревью выделены'}{' '}
          · +{[...change.steps.values()].filter((value) => value === 'added').length} вызовов ·{' '}
          {change.steps.size -
            [...change.steps.values()].filter((value) => value === 'added').length}{' '}
          изменено · −{change.removed.length}
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
          <strong>Убрано после прошлого ревью</strong>
          <ul>
            {change.removed.map((step) => (
              <li key={step.id}>{step.label}</li>
            ))}
          </ul>
        </div>
      )}
      {change?.previous && change.previous.summary !== summary && (
        <details className="scenario-before-description">
          <summary>Описание до исправлений</summary>
          <Markdown>{reviewDescription(change.previous.summary, 'scenario')}</Markdown>
        </details>
      )}
    </div>
  );
}
