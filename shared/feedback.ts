/** Kinds of feedback; the title prefix keeps the kind visible, since labels need write access. */
export const feedbackKinds = [
  { id: 'bug', title: 'Bug', prefix: 'Bug', label: 'bug' },
  { id: 'feature', title: 'Feature request', prefix: 'Feature', label: 'enhancement' },
  { id: 'improvement', title: 'Improvement', prefix: 'Improvement', label: 'enhancement' },
  { id: 'question', title: 'Question', prefix: 'Question', label: 'question' },
] as const;
export type FeedbackKind = (typeof feedbackKinds)[number]['id'];
export const feedbackKindIds = feedbackKinds.map((kind) => kind.id) as [
  FeedbackKind,
  ...FeedbackKind[],
];

export interface FeedbackIssue {
  number: number;
  /** The title without its kind prefix. */
  title: string;
  kind?: FeedbackKind;
  state: 'open' | 'closed';
  url: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  /** Replies by other people since the issue was last opened in the app. */
  unread: number;
}
export interface FeedbackComment {
  id: number;
  author: string;
  body: string;
  at: string;
  url: string;
  own: boolean;
}
export interface FeedbackThread {
  issue: FeedbackIssue & { body: string; author: string };
  comments: FeedbackComment[];
}
export interface FeedbackList {
  repository: string;
  login: string;
  issues: FeedbackIssue[];
}

export function feedbackTitle(kind: FeedbackKind, title: string) {
  return `[${feedbackKinds.find((item) => item.id === kind)!.prefix}] ${title.trim()}`;
}
/** Reads the kind back from a title the app wrote; other titles are kept as they are. */
export function parseFeedbackTitle(title: string): { kind?: FeedbackKind; title: string } {
  const match = /^\[(\w+)\]\s*(.*)$/s.exec(title);
  const kind = match && feedbackKinds.find((item) => item.prefix === match[1]);
  return kind ? { kind: kind.id, title: match[2] } : { title };
}
