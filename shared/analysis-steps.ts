import type { PromptId } from './prompt-templates.js';

/**
 * Stages after the main review that can be switched off to save time and tokens. A switched-off
 * stage does not run automatically; its own button on the page still runs it for one review.
 */
export const optionalSteps = [
  {
    id: 'changes',
    title: 'Change descriptions',
    effect: 'The “What changes” cards are not built; the main review runs without them.',
    prompts: ['changes', 'changesUi', 'reuseCards'],
  },
  {
    id: 'scenarios',
    title: 'Scenario completion',
    effect:
      'Diagrams of the main review remain. Missing ones can be completed with “Complete scenarios”.',
    onDemand:
      'Diagrams of the main review remain. Another entry method gets its diagram on request from its page.',
    prompts: ['scenarios'],
  },
  {
    id: 'sql',
    title: 'SQL and database changes',
    effect: 'Database queries are not rebuilt. For a method, use “Complete SQL with Codex”.',
    onDemand: 'SQL is generated on request, only for the method whose query you open.',
    prompts: ['database'],
  },
  {
    id: 'tests',
    title: 'Test descriptions',
    effect: 'Tests are described with “Complete the test analysis”.',
    prompts: ['tests'],
  },
] as const satisfies readonly {
  id: string;
  title: string;
  effect: string;
  /** What running the stage on request means, for stages that work per method. */
  onDemand?: string;
  prompts: readonly PromptId[];
}[];
export type OptionalStep = (typeof optionalSteps)[number]['id'];
export const optionalStepIds = optionalSteps.map((step) => step.id) as [
  OptionalStep,
  ...OptionalStep[],
];
/** Stages that can run on request for one method instead of for the whole review. */
export const onDemandStepIds = ['scenarios', 'sql'] as const;
export type OnDemandStep = (typeof onDemandStepIds)[number];
/** How a stage runs: with every review, on request per method, or on request for all at once. */
export type StepMode = 'auto' | 'method' | 'all';
export const stepMode = (
  step: OptionalStep,
  settings: { disabled: OptionalStep[]; onDemand: OnDemandStep[] },
): StepMode =>
  (settings.onDemand as OptionalStep[]).includes(step)
    ? 'method'
    : settings.disabled.includes(step)
      ? 'all'
      : 'auto';
/** The optional stage a prompt template belongs to, if it is not part of the main review. */
export const stepOfPrompt = (id: PromptId) =>
  optionalSteps.find((step) => (step.prompts as readonly PromptId[]).includes(id));
