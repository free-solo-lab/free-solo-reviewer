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
  { content: '+1', emoji: '👍', label: 'Нравится' },
  { content: '-1', emoji: '👎', label: 'Не нравится' },
  { content: 'laugh', emoji: '😄', label: 'Смешно' },
  { content: 'hooray', emoji: '🎉', label: 'Ура' },
  { content: 'confused', emoji: '😕', label: 'Непонятно' },
  { content: 'heart', emoji: '❤️', label: 'Сердце' },
  { content: 'rocket', emoji: '🚀', label: 'Ракета' },
  { content: 'eyes', emoji: '👀', label: 'Смотрю' },
];
export interface ReviewReaction {
  content: ReactionContent;
  count: number;
  viewerHasReacted?: boolean;
}
