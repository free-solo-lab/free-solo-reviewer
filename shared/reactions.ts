import { t } from './i18n.js';
export const REACTION_CONTENTS = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
] as const;
export type ReactionContent = (typeof REACTION_CONTENTS)[number];
export const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] = [
  { content: '+1', emoji: '👍', label: t('Like') },
  { content: '-1', emoji: '👎', label: t('Dislike') },
  { content: 'laugh', emoji: '😄', label: t('Laugh') },
  { content: 'hooray', emoji: '🎉', label: t('Hooray') },
  { content: 'confused', emoji: '😕', label: t('Confused') },
  { content: 'heart', emoji: '❤️', label: t('Heart') },
  { content: 'rocket', emoji: '🚀', label: t('Rocket') },
  { content: 'eyes', emoji: '👀', label: t('Eyes') },
];
export interface ReviewReaction {
  content: ReactionContent;
  count: number;
  viewerHasReacted?: boolean;
}
