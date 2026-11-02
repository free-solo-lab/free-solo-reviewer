import { expect, it } from 'vitest';
import { stepDescription } from '../shared/step-description';
import { scenarioSchema } from '../shared/model';
import { renderPrompt } from '../shared/prompt-templates';
const step = (label: string, description?: string) => ({
  id: 's',
  from: 'a',
  to: 'b',
  kind: 'call' as const,
  change: 'added' as const,
  confidence: 'inferred' as const,
  branch: '',
  evidence: [],
  label,
  description,
});
it('shows explicit meaning or saved prose, without inventing descriptions from method names', () => {
  expect(stepDescription(step('A.load -> B.find: Finds documents visible to this user'))).toBe(
    'Finds documents visible to this user',
  );
  expect(stepDescription(step('loadDocument()'))).toBe('');
  expect(stepDescription(step('A.load -> B.find'))).toBe('');
  expect(stepDescription(step('loadDocument()', 'Checks access and loads document metadata'))).toBe(
    'Checks access and loads document metadata',
  );
  expect(
    scenarioSchema.shape.steps.element.parse(step('loadDocument()')).description,
  ).toBeUndefined();
});
it('requests the meaning of every call in the existing analysis rather than a separate model pass', () => {
  expect(
    renderPrompt('analysis', {
      language: 'English',
      stage: 'review',
      cardsContext: '',
      reviewInstructions: '',
      scenarioInstructions: '',
      databaseInstructions: '',
      chainInstructions: '',
      userMessages: '',
    }),
  ).toContain('For EVERY scenario step, fill description');
});
