import { renderPrompt, type PromptOverrides } from '../shared/prompt-templates.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { changeKinds, type ChangeCard } from '../shared/model.js';
import type { ChangeUnit } from '../shared/change-units.js';
import { t } from '../shared/i18n.js';

export const cardDraft = z.object({
  kind: z.enum(changeKinds),
  risk: z.enum(['none', 'check', 'high']),
  text: z.string(),
});
export type CardDraft = z.infer<typeof cardDraft>;
const cardsAnswer = z.object({ cards: z.array(cardDraft.extend({ id: z.string() })) });
export const cardsSchema = z.toJSONSchema(cardsAnswer);
const BATCH_CHARS = 40_000;
const PARALLEL = 3;

/** The same change gets the same card, wherever its lines moved; line numbers are not hashed. */
export const cardKey = (unit: ChangeUnit) =>
  createHash('sha256')
    .update(
      [
        unit.ui ? 'card-ui-1' : 'card-1',
        unit.name,
        ...unit.diff.map((line) => line.replace(/^([ +-])\d+ /, '$1')),
      ].join('\n'),
    )
    .digest('hex');

export function cardsPrompt(units: ChangeUnit[], overrides: PromptOverrides = {}) {
  return renderPrompt(
    'changes',
    {
      uiInstructions: units.some((unit) => unit.ui) ? renderPrompt('changesUi', {}, overrides) : '',
      changes: units
        .map(
          (unit, i) =>
            `### C${i + 1} ${unit.name}${unit.ui ? ' (UI)' : ''}\n${unit.diff.join('\n')}`,
        )
        .join('\n\n'),
    },
    overrides,
  );
}
export function parseCards(answer: unknown, count: number) {
  const parsed = cardsAnswer.safeParse(answer);
  const byId = new Map((parsed.data?.cards ?? []).map(({ id, ...card }) => [id, card]));
  return Array.from({ length: count }, (_, i) => byId.get(`C${i + 1}`));
}

/** Units in batches that fit one short turn each. */
function batches(units: ChangeUnit[]) {
  const result: ChangeUnit[][] = [];
  let size = 0;
  for (const unit of units) {
    const chars = unit.diff.join('\n').length + unit.name.length;
    if (!result.length || size + chars > BATCH_CHARS) {
      result.push([]);
      size = 0;
    }
    result.at(-1)!.push(unit);
    size += chars;
  }
  return result;
}

/**
 * Cards for every unit: known changes come from the cache, the rest are described in small
 * parallel turns and cached. A unit the model skipped gets no card rather than a guess.
 */
export async function changeCards(
  units: ChangeUnit[],
  cache: {
    get: (key: string) => CardDraft | undefined;
    set: (key: string, card: CardDraft) => void;
  },
  describe: (units: ChangeUnit[]) => Promise<(CardDraft | undefined)[]>,
  progress: (message: string) => void,
): Promise<ChangeCard[]> {
  const drafts = new Map(units.map((unit) => [unit, cache.get(cardKey(unit))]));
  const missing = units.filter((unit) => !drafts.get(unit));
  if (missing.length) {
    progress(
      t(
        'Describing changes: {0} of {1}{2}…',
        missing.length,
        units.length,
        units.length > missing.length ? t(', the rest are already known') : '',
      ),
    );
    const queue = batches(missing);
    const run = async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        const described = await describe(batch);
        batch.forEach((unit, i) => {
          const card = described[i];
          if (!card) return;
          drafts.set(unit, card);
          cache.set(cardKey(unit), card);
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, run));
  }
  return units.flatMap((unit) => {
    const draft = drafts.get(unit);
    return draft
      ? [
          {
            id: unit.key,
            name: unit.name,
            evidence: unit.evidence,
            ...draft,
            ...(unit.ui && { ui: true }),
          },
        ]
      : [];
  });
}
