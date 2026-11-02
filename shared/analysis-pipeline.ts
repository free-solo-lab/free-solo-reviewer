import type { OptionalStep } from './analysis-steps.js';
import type { PromptId } from './prompt-templates.js';

/** A prompt of a stage's request and, for parts that are not always there, when it is added. */
export interface PipelinePrompt {
  id: PromptId;
  when?: string;
  /** Sent instead of the previous prompt, not together with it. */
  instead?: boolean;
}
export interface PipelineStage {
  id: 'prepare' | 'changes' | 'review' | 'scenarios' | 'sql' | 'tests';
  title: string;
  summary: string;
  /** Local stages read the code on this computer and send nothing to the model. */
  runs: 'local' | 'codex';
  /** The setting that switches the stage; stages without one always run. */
  step?: OptionalStep;
  /** The request in the order it is assembled; a wrapper comes first and holds the rest. */
  prompts: PipelinePrompt[];
}

const chainPrompts: PipelinePrompt[] = [
  { id: 'sequenceChain', when: 'when the index resolved the call chains' },
  { id: 'sequenceFallback', when: 'otherwise', instead: true },
];

/**
 * The stages of an analysis in the order they run, with the prompts each one sends. It mirrors
 * `server/analysis.ts` and `localAnalysisPrompt`; a test checks that every prompt has a place here.
 */
export const analysisPipeline: PipelineStage[] = [
  {
    id: 'prepare',
    title: 'Preparation',
    summary:
      'Pins the base and head code of every repository, indexes classes, methods and calls, and reads contracts and migrations. Nothing is sent to the model.',
    runs: 'local',
    prompts: [],
  },
  {
    id: 'changes',
    title: 'Change descriptions',
    summary:
      'Short cards of what each changed method or file does, from small diffs only, without access to the code.',
    runs: 'codex',
    step: 'changes',
    prompts: [{ id: 'changes' }, { id: 'changesUi', when: 'when user interface code changed' }],
  },
  {
    id: 'review',
    title: 'Main review',
    summary:
      'The overview, remarks with a risk level and the affected call sequences. Codex reads the pinned code in a read-only sandbox without network access.',
    runs: 'codex',
    prompts: [
      { id: 'analysis' },
      { id: 'review' },
      { id: 'reuseCards', when: 'when change cards are prepared' },
      ...chainPrompts,
    ],
  },
  {
    id: 'scenarios',
    title: 'Scenario completion',
    summary: 'Completes the call sequences of entry points the main review did not cover.',
    runs: 'codex',
    step: 'scenarios',
    prompts: [{ id: 'analysis' }, { id: 'scenarios' }, ...chainPrompts],
  },
  {
    id: 'sql',
    title: 'SQL and database changes',
    summary:
      'Rebuilds the SQL of changed queries and migrations with conditions, bind parameters and the dialect.',
    runs: 'codex',
    step: 'sql',
    prompts: [{ id: 'analysis' }, { id: 'database' }, { id: 'sequenceFallback' }],
  },
  {
    id: 'tests',
    title: 'Test descriptions',
    summary:
      'Titles and descriptions of what changed tests check. Their steps are extracted locally.',
    runs: 'codex',
    step: 'tests',
    prompts: [{ id: 'tests' }],
  },
];
/** Put before a stage's request when it resumes after an interruption. */
export const CONTINUATION_PROMPT: PromptId = 'continuation';
