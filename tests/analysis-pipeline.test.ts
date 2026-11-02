import { expect, it } from 'vitest';
import { analysisPipeline, CONTINUATION_PROMPT } from '../shared/analysis-pipeline';
import { optionalSteps } from '../shared/analysis-steps';
import { promptTemplates } from '../shared/prompt-templates';

it('shows every prompt and every switchable stage on the analysis scheme', () => {
  const shown = new Set([
    CONTINUATION_PROMPT,
    ...analysisPipeline.flatMap((stage) => stage.prompts.map((prompt) => prompt.id)),
  ]);
  expect(promptTemplates.map((prompt) => prompt.id).filter((id) => !shown.has(id))).toEqual([]);
  expect(analysisPipeline.flatMap((stage) => stage.step ?? []).sort()).toEqual(
    optionalSteps.map((step) => step.id).sort(),
  );
  // A prompt of a switchable stage is sent there, or elsewhere only under a stated condition.
  for (const step of optionalSteps)
    for (const id of step.prompts) {
      const own = analysisPipeline.find((stage) => stage.step === step.id)!;
      const elsewhere = analysisPipeline.flatMap((stage) =>
        stage === own ? [] : stage.prompts.filter((prompt) => prompt.id === id),
      );
      expect(
        own.prompts.some((prompt) => prompt.id === id) ||
          (elsewhere.length > 0 && elsewhere.every((prompt) => prompt.when)),
      ).toBe(true);
    }
});
