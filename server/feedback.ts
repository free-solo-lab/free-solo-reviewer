import { arch, platform, release } from 'node:os';
import {
  feedbackKinds,
  feedbackTitle,
  parseFeedbackTitle,
  type FeedbackComment,
  type FeedbackIssue,
  type FeedbackKind,
  type FeedbackList,
  type FeedbackThread,
} from '../shared/feedback.js';
import { getLanguage, t } from '../shared/i18n.js';
import { AppError } from './process.js';
import type { Store } from './store.js';

/** Where feedback goes: the project's own repository, unless a fork points elsewhere. */
export const FEEDBACK_REPOSITORY =
  process.env.REVIEW_FEEDBACK_REPO ?? 'free-solo-lab/free-solo-reviewer';
/** Unread replies are counted only for the most recently updated issues. */
const CHECKED_ISSUES = 20;

export interface FeedbackGateway {
  api<T>(endpoint: string, options?: { method: string; body: unknown }, slug?: string): Promise<T>;
  user(slug?: string): Promise<{ login: string }>;
}
interface IssueRow {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  user: { login: string } | null;
  pull_request?: unknown;
}
interface CommentRow {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  user: { login: string } | null;
}

/** Technical details a bug report may carry; nothing about the reviewed code. */
export function feedbackDiagnostics() {
  return `Reviewer · ${platform()} ${release()} ${arch()} · Node.js ${process.versions.node} · ${getLanguage()}`;
}

/**
 * Feedback as issues of the project's repository, written by the user's own GitHub account.
 * The app keeps only when each issue was last read, to show new replies.
 */
export class Feedback {
  constructor(
    private store: Store,
    private github: FeedbackGateway,
    readonly repository = FEEDBACK_REPOSITORY,
  ) {}
  private api<T>(endpoint: string, options?: { method: string; body: unknown }) {
    return this.github.api<T>(`repos/${this.repository}/${endpoint}`, options, this.repository);
  }
  private login() {
    return this.github.user(this.repository).then((user) => user.login);
  }
  private issue(row: IssueRow, unread = 0): FeedbackIssue {
    return {
      number: row.number,
      ...parseFeedbackTitle(row.title),
      state: row.state,
      url: row.html_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      comments: row.comments,
      unread,
    };
  }
  private async comments(number: number) {
    const rows: CommentRow[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<CommentRow[]>(
        `issues/${number}/comments?per_page=100&page=${page}`,
      );
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }
  /** GitHub's own timestamps, so a clock difference with this computer never hides a reply. */
  private markRead(number: number, at: string) {
    const seen = this.store.feedbackSeen();
    if (!seen[number] || seen[number] < at) this.store.saveFeedbackSeen({ ...seen, [number]: at });
  }
  async list(): Promise<FeedbackList> {
    const login = await this.login();
    const rows = (
      await this.api<IssueRow[]>(
        `issues?${new URLSearchParams({ creator: login, state: 'all', sort: 'updated', per_page: '50' })}`,
      )
    ).filter((row) => !row.pull_request);
    const seen = this.store.feedbackSeen();
    const issues = await Promise.all(
      rows.map(async (row, index) => {
        // Never opened in the app: every reply by someone else is new.
        const since = seen[row.number] ?? row.created_at;
        if (index >= CHECKED_ISSUES || !row.comments || row.updated_at <= since)
          return this.issue(row);
        const replies = (await this.comments(row.number)).filter(
          (comment) =>
            comment.created_at > since && comment.user?.login.toLowerCase() !== login.toLowerCase(),
        );
        return this.issue(row, replies.length);
      }),
    );
    return { repository: this.repository, login, issues };
  }
  async create(kind: FeedbackKind, title: string, body: string, diagnostics: boolean) {
    const definition = feedbackKinds.find((item) => item.id === kind)!;
    const row = await this.api<IssueRow>('issues', {
      method: 'POST',
      body: {
        title: feedbackTitle(kind, title),
        body: [
          body.trim(),
          diagnostics ? `---\n<sub>${feedbackDiagnostics()}</sub>` : '',
          `<!-- reviewer-feedback:${kind} -->`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        // GitHub drops labels the author may not set, so the title prefix carries the kind too.
        labels: [definition.label],
      },
    });
    this.markRead(row.number, row.created_at);
    return this.issue(row);
  }
  async thread(number: number): Promise<FeedbackThread> {
    const [login, row, comments] = await Promise.all([
      this.login(),
      this.api<IssueRow>(`issues/${number}`),
      this.comments(number),
    ]);
    if (row.pull_request) throw new AppError(t('Issue not found.'), 404);
    this.markRead(
      number,
      [row.updated_at, ...comments.map((comment) => comment.created_at)].sort().at(-1)!,
    );
    const own = (author?: string) => author?.toLowerCase() === login.toLowerCase();
    return {
      issue: {
        ...this.issue(row),
        body: withoutMarker(row.body ?? ''),
        author: row.user?.login ?? '',
      },
      comments: comments.map((comment): FeedbackComment => ({
        id: comment.id,
        author: comment.user?.login ?? '',
        body: comment.body ?? '',
        at: comment.created_at,
        url: comment.html_url,
        own: own(comment.user?.login),
      })),
    };
  }
  async reply(number: number, body: string) {
    await this.api<CommentRow>(`issues/${number}/comments`, {
      method: 'POST',
      body: { body: body.trim() },
    });
    return this.thread(number);
  }
}
const withoutMarker = (body: string) =>
  body.replace(/\n*<!-- reviewer-feedback:\w+ -->\s*$/, '').trimEnd();
