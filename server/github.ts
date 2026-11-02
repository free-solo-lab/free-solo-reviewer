import {
  REACTION_CONTENTS,
  type ReactionContent,
  type ReviewReaction,
} from '../shared/reactions.js';
import { command, AppError, CommandError } from './process.js';
import type { PullRequest, ReviewAction, ReviewDiscussion } from '../shared/model.js';
export interface RemoteReview {
  id: number;
  html_url: string;
  body: string;
  commit_id: string;
  state: string;
  user: { login: string };
}
export interface GitHubGateway {
  listPRs(slug: string): Promise<PullRequest[]>;
  pull(slug: string, number: number): Promise<PullRequest>;
  user(): Promise<{ login: string }>;
  permission(slug: string): Promise<boolean>;
  reviews(slug: string, number: number): Promise<RemoteReview[]>;
  discussion?(slug: string, number: number): Promise<Omit<ReviewDiscussion, 'repoId'>[]>;
  commentReactions?(slug: string, commentId: number): Promise<ReviewReaction[]>;
  setCommentReaction?(
    slug: string,
    commentId: number,
    content: ReactionContent,
    active: boolean,
  ): Promise<ReviewReaction[]>;
  reply?(
    slug: string,
    number: number,
    rootId: number,
    body: string,
  ): Promise<Omit<ReviewDiscussion, 'repoId'>>;
  submit(slug: string, number: number, payload: ReviewPayload): Promise<RemoteReview>;
}
export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: ReviewAction;
  comments: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[];
}
export class GitHubApiError extends AppError {
  constructor(
    message: string,
    public httpStatus: number,
  ) {
    super(message, httpStatus);
  }
}
export function parseHttpResponse(text: string): { status: number; body: string } {
  const match = /^HTTP\/\S+\s+(\d{3})[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new AppError('GitHub CLI не вернул ожидаемые HTTP-заголовки.', 502);
  return { status: Number(match[1]), body: match[3] };
}
export class GitHub implements GitHubGateway {
  async api<T>(endpoint: string, options?: { method: string; body: unknown }): Promise<T> {
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--include',
      endpoint,
      '-H',
      'Accept: application/vnd.github+json',
    ];
    if (options) {
      args.push('--method', options.method);
      if (options.body !== undefined) args.push('--input', '-');
    }
    try {
      const text = await command('gh', args, {
        input: options ? JSON.stringify(options.body) : undefined,
        timeout: 45_000,
      });
      const body = parseHttpResponse(text).body;
      return (body.trim() ? JSON.parse(body) : undefined) as T;
    } catch (error) {
      if (error instanceof CommandError) {
        let response: ReturnType<typeof parseHttpResponse> | null = null;
        try {
          response = parseHttpResponse(error.stdout);
        } catch {
          /* No response: transport uncertainty. */
        }
        if (
          response &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408
        ) {
          let message = 'GitHub отклонил запрос';
          try {
            message = JSON.parse(response.body).message ?? message;
          } catch {
            /* Keep a bounded generic error. */
          }
          throw new GitHubApiError(`${message} (HTTP ${response.status})`, response.status);
        }
      }
      throw error;
    }
  }
  async listPRs(slug: string): Promise<PullRequest[]> {
    return JSON.parse(
      await command('gh', [
        'pr',
        'list',
        '--repo',
        slug,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,url,headRefOid,baseRefOid,baseRefName,headRefName,body,author',
      ]),
    );
  }
  async pull(slug: string, number: number): Promise<PullRequest> {
    const p = await this.api<{
      number: number;
      title: string;
      html_url: string;
      head: { sha: string; ref: string };
      base: { sha: string; ref: string };
      body: string | null;
      user: { login: string };
      state: string;
    }>(`repos/${slug}/pulls/${number}`);
    if (p.state !== 'open') throw new AppError('PR уже закрыт.', 409);
    return {
      number: p.number,
      title: p.title,
      url: p.html_url,
      headRefOid: p.head.sha,
      baseRefOid: p.base.sha,
      headRefName: p.head.ref,
      baseRefName: p.base.ref,
      body: p.body ?? '',
      author: p.user,
    };
  }
  user() {
    return this.api<{ login: string }>('user');
  }
  async permission(slug: string) {
    const r = await this.api<{ permissions?: { pull?: boolean }; role_name?: string }>(
      `repos/${slug}`,
    );
    return r.permissions?.pull === true;
  }
  async reviews(slug: string, number: number) {
    const result: RemoteReview[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.api<RemoteReview[]>(
        `repos/${slug}/pulls/${number}/reviews?per_page=100&page=${page}`,
      );
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }
  submit(slug: string, number: number, payload: ReviewPayload) {
    return this.api<RemoteReview>(`repos/${slug}/pulls/${number}/reviews`, {
      method: 'POST',
      body: payload,
    });
  }
  private async reactionRows(slug: string, commentId: number) {
    const result: { id: number; content: ReactionContent; user: { login: string } | null }[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.api<typeof result>(
        `repos/${slug}/pulls/comments/${commentId}/reactions?per_page=100&page=${page}`,
      );
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }
  private summarizeReactions(
    rows: { id: number; content: ReactionContent; user: { login: string } | null }[],
    login: string | null,
  ): ReviewReaction[] {
    return REACTION_CONTENTS.flatMap((content) => {
      const matches = rows.filter((reaction) => reaction.content === content);
      return matches.length
        ? [
            {
              content,
              count: matches.length,
              ...(login
                ? {
                    viewerHasReacted: matches.some(
                      (reaction) => reaction.user?.login.toLowerCase() === login.toLowerCase(),
                    ),
                  }
                : {}),
            },
          ]
        : [];
    });
  }
  async commentReactions(slug: string, commentId: number): Promise<ReviewReaction[]> {
    const viewer = await this.user();
    return this.summarizeReactions(await this.reactionRows(slug, commentId), viewer.login);
  }
  async setCommentReaction(
    slug: string,
    commentId: number,
    content: ReactionContent,
    active: boolean,
  ): Promise<ReviewReaction[]> {
    const viewer = await this.user();
    let rows = await this.reactionRows(slug, commentId);
    const own = rows.filter(
      (reaction) =>
        reaction.content === content &&
        reaction.user?.login.toLowerCase() === viewer.login.toLowerCase(),
    );
    if (active && !own.length) {
      const reaction = await this.api<(typeof rows)[number]>(
        `repos/${slug}/pulls/comments/${commentId}/reactions`,
        { method: 'POST', body: { content } },
      );
      rows = [...rows.filter((existing) => existing.id !== reaction.id), reaction];
    } else if (!active) {
      for (const reaction of own)
        await this.api<void>(`repos/${slug}/pulls/comments/${commentId}/reactions/${reaction.id}`, {
          method: 'DELETE',
          body: undefined,
        });
      rows = rows.filter((reaction) => !own.some((mine) => mine.id === reaction.id));
    }
    return this.summarizeReactions(rows, viewer.login);
  }
  async reply(
    slug: string,
    number: number,
    rootId: number,
    body: string,
  ): Promise<Omit<ReviewDiscussion, 'repoId'>> {
    const row = await this.api<{
      id: number;
      body: string;
      html_url: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    }>(`repos/${slug}/pulls/${number}/comments/${rootId}/replies`, {
      method: 'POST',
      body: { body },
    });
    return {
      id: `inline:${row.id}`,
      replyTo: `inline:${rootId}`,
      body: row.body,
      author: row.user.login,
      url: row.html_url,
      at: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async discussion(slug: string, number: number) {
    type Comment = {
      id: number;
      body: string | null;
      html_url: string;
      user: { login: string } | null;
      created_at?: string;
      submitted_at?: string;
      updated_at?: string;
      in_reply_to_id?: number;
      pull_request_review_id?: number;
      path?: string;
      side?: 'LEFT' | 'RIGHT';
      line?: number | null;
      start_line?: number | null;
      original_line?: number | null;
      original_start_line?: number | null;
      commit_id?: string;
      original_commit_id?: string;
      reactions?: Partial<Record<ReactionContent, number>>;
    };
    const result: Omit<ReviewDiscussion, 'repoId'>[] = [];
    for (const [kind, endpoint] of [
      ['comment', `repos/${slug}/issues/${number}/comments`],
      ['inline', `repos/${slug}/pulls/${number}/comments`],
      ['review', `repos/${slug}/pulls/${number}/reviews`],
    ]) {
      for (let page = 1; ; page++) {
        const rows = await this.api<Comment[]>(`${endpoint}?per_page=100&page=${page}`);
        for (const row of rows)
          if (row.body)
            result.push({
              id: `${kind}:${row.id}`,
              body: row.body,
              author: row.user?.login ?? '',
              url: row.html_url,
              at: row.created_at ?? row.submitted_at ?? '',
              updatedAt: row.updated_at ?? row.created_at ?? row.submitted_at ?? '',
              ...(row.in_reply_to_id ? { replyTo: `inline:${row.in_reply_to_id}` } : {}),
              ...(kind === 'inline'
                ? {
                    reactions: REACTION_CONTENTS.flatMap((content) =>
                      (row.reactions?.[content] ?? 0) > 0
                        ? [{ content, count: row.reactions![content]! }]
                        : [],
                    ),
                    reviewId: row.pull_request_review_id,
                    commitId: row.commit_id,
                    originalCommitId: row.original_commit_id,
                    ...(row.path
                      ? {
                          location: {
                            path: row.path,
                            side: row.side === 'LEFT' ? ('base' as const) : ('head' as const),
                            line: row.line ?? null,
                            startLine: row.start_line,
                            originalLine: row.original_line,
                            originalStartLine: row.original_start_line,
                          },
                        }
                      : {}),
                  }
                : {}),
            });
        if (rows.length < 100) break;
      }
    }
    const withReactions = result.filter(
      (comment) => comment.id.startsWith('inline:') && comment.reactions?.length,
    );
    if (withReactions.length) {
      const login = await this.user()
        .then((user) => user.login)
        .catch(() => null);
      for (let i = 0; i < withReactions.length; i += 4)
        await Promise.all(
          withReactions.slice(i, i + 4).map(async (comment) => {
            try {
              comment.reactions = this.summarizeReactions(
                await this.reactionRows(slug, Number(comment.id.slice(7))),
                login,
              );
            } catch {
              /* Keep GitHub's counts if detailed reaction loading is unavailable. */
            }
          }),
        );
    }
    return result;
  }
}
export function githubSlug(remote: string): string {
  const value = remote.trim().replace(/\.git$/, '');
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/.exec(
      value,
    );
  if (!match) throw new AppError('Нужен origin на github.com (HTTPS или SSH).');
  return match[1];
}
