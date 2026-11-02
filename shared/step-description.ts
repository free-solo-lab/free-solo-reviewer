import type { Scenario } from './model.js';

/** Reuse saved prose; never guess a method's purpose from its identifier. */
export function stepDescription(step: Scenario['steps'][number]) {
  if (step.description?.trim()) return step.description.trim();
  const label = step.label.trim();
  const tail =
    label.includes('->') || label.includes('→') ? (label.match(/:\s+(.+)$/)?.[1] ?? '') : label;
  return tail && /\s/.test(tail) && !/^[\w.$]+\s*\(/.test(tail) ? tail : '';
}
