import {
  REACTION_CONTENTS,
  type ReactionContent,
  type ReviewReaction,
} from '../shared/reactions.js';
import { command, AppError, CommandError, type CommandOptions } from './process.js';
import type {
  GitHubAccounts,
  PullRequest,
  ReviewAction,
  ReviewDiscussion,
  ReviewRequest,
} from '../shared/model.js';
import { t } from '../shared/i18n.js';
export interface RemoteReview {
  id: number;
  html_url: string;
  body: string;
  commit_id: string;
  state: string;
  user: { login: string };
}
export interface GitHubGateway {
  remoteState?(
    slug: string,
    number: number,
  ): Promise<{
    state: 'open' | 'closed' | 'merged';
    headSha: string;
    decision: 'approved' | 'changes_requested' | 'review_required' | 'unknown';
  }>;
  findPullRequest?(slug: string, branch: string, base?: string): Promise<PullRequest | undefined>;
  createPullRequest?(
    slug: string,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequest>;
  listPRs(slug: string): Promise<PullRequest[]>;
  pull(slug: string, number: number): Promise<PullRequest>;
  /** The account acting on `slug`'s repository, or the active one without a slug. */
  user(slug?: string): Promise<{ login: string }>;
  accounts?(): Promise<GitHubAccounts>;
  /** Requests for `login`, or for the current user without one. */
  reviewRequests?(login?: string): Promise<Omit<ReviewRequest, 'repoId'>[]>;
  permission(slug: string): Promise<boolean>;
  reviews(slug: string, number: number): Promise<RemoteReview[]>;
  discussion?(slug: string, number: number): Promise<Omit<ReviewDiscussion, 'repoId'>[]>;
  commentReactions?(slug: string, commentId: number): Promise<ReviewReaction[]>;
  reactDiscussion?(
    slug: string,
    number: number,
    id: string,
    content: ReactionContent,
    active: boolean,
  ): Promise<ReviewReaction[]>;
  replyDiscussion?(
    slug: string,
    number: number,
    root: ReviewDiscussion,
    body: string,
  ): Promise<Omit<ReviewDiscussion, 'repoId'>>;
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
  if (!match) throw new AppError(t('GitHub CLI did not return the expected HTTP headers.'), 502);
  return { status: Number(match[1]), body: match[3] };
}
/** One entry of GitHub's `errors`: a plain string or `{ message }` / `{ field, code }`. */
function githubErrorDetail(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const { message, field, code } = error as Record<string, unknown>;
  if (typeof message === 'string') return message;
  return [field, code].filter((part) => typeof part === 'string').join(': ');
}
/**
 * GitHub's own reason for a rejected request. Validation failures (422) carry it in `errors`;
 * the top-level message is then only "Unprocessable Entity" or "Validation Failed".
 */
export function githubErrorMessage(body: string): string {
  let parsed: { message?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return t('GitHub rejected the request');
  }
  const message =
    typeof parsed.message === 'string' ? parsed.message : t('GitHub rejected the request');
  const details = Array.isArray(parsed.errors)
    ? parsed.errors.map(githubErrorDetail).filter(Boolean)
    : [];
  return [message, ...new Set(details)].join(': ').slice(0, 1000);
}
/** Accounts `gh` is logged in to; the active one serves repositories without a chosen account. */
export async function githubAccounts(): Promise<GitHubAccounts> {
  const status = JSON.parse(
    await command('gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], {
      timeout: 15_000,
    }),
  ) as { hosts?: Record<string, { login: string; active: boolean; state: string }[]> };
  const rows = (status.hosts?.['github.com'] ?? []).filter((row) => row.state === 'success');
  return {
    active: rows.find((row) => row.active)?.login ?? null,
    accounts: rows.map((row) => row.login),
  };
}
const TOKEN_TTL_MS = 60_000;
export class GitHub implements GitHubGateway {
  private tokens = new Map<string, { token: Promise<string>; until: number }>();
  /**
   * `accountFor` names the account that acts on a repository, or without a slug the current
   * user; `gh` uses its token. Without a name `gh` uses its active account.
   */
  constructor(private accountFor: (slug?: string) => string | undefined = () => undefined) {}
  accounts() {
    return githubAccounts();
  }
  private token(login: string) {
    const cached = this.tokens.get(login);
    if (cached && cached.until > Date.now()) return cached.token;
    const token = command('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], {
      timeout: 15_000,
    }).then(
      (output) => output.trim(),
      () => {
        this.tokens.delete(login);
        throw new GitHubApiError(
          t(
            'GitHub account {0} is not signed in to gh. Run gh auth login and sign in to it, or choose another account for the repository.',
            login,
          ),
          401,
        );
      },
    );
    this.tokens.set(login, { token, until: Date.now() + TOKEN_TTL_MS });
    return token;
  }
  /** Runs `gh` as `login`, else as the repository's account or the current user. */
  private async gh(
    args: string[],
    slug: string | undefined,
    options: CommandOptions = {},
    as?: string,
  ) {
    const login = as ?? this.accountFor(slug);
    return command('gh', args, {
      ...options,
      ...(login ? { env: { ...process.env, GH_TOKEN: await this.token(login) } } : {}),
    });
  }
  async api<T>(
    endpoint: string,
    options?: { method: string; body: unknown },
    slug = /^repos\/([^/]+\/[^/?]+)/.exec(endpoint)?.[1],
    as?: string,
  ): Promise<T> {
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
      const text = await this.gh(
        args,
        slug,
        { input: options ? JSON.stringify(options.body) : undefined, timeout: 45_000 },
        as,
      );
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
          throw new GitHubApiError(
            `${githubErrorMessage(response.body)} (HTTP ${response.status})`,
            response.status,
          );
        }
      }
      throw error;
    }
  }
  /** Open PRs that request a review from `login` (the current user by default) or their team. */
  async reviewRequests(login?: string) {
    type Item = {
      number: number;
      title: string;
      html_url: string;
      repository_url: string;
      user: { login: string } | null;
      updated_at: string;
      draft?: boolean;
    };
    const search = (qualifier: string) =>
      this.api<{ items: Item[] }>(
        `search/issues?${new URLSearchParams({
          q: `is:pr is:open archived:false ${qualifier}:@me`,
          sort: 'updated',
          per_page: '100',
        })}`,
        undefined,
        undefined,
        login,
      ).then((result) => result.items);
    const [all, direct] = await Promise.all([
      search('review-requested'),
      search('user-review-requested'),
    ]);
    const personal = new Set(direct.map((item) => item.html_url));
    return all.map((item) => ({
      slug: item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, ''),
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user?.login ?? 'ghost',
      updatedAt: item.updated_at,
      draft: item.draft ?? false,
      direct: personal.has(item.html_url),
    }));
  }
  async listPRs(slug: string): Promise<PullRequest[]> {
    return JSON.parse(
      await this.gh(
        [
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
        ],
        slug,
      ),
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
      merged_at: string | null;
    }>(`repos/${slug}/pulls/${number}`);
    return {
      number: p.number,
      state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
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
  async remoteState(slug: string, number: number) {
    const [owner, name] = slug.split('/');
    const result = await this.api<{
      data: {
        repository: {
          pullRequest: { state: string; reviewDecision: string | null; headRefOid: string };
        };
      };
      errors?: { message: string }[];
    }>(
      'graphql',
      {
        method: 'POST',
        body: {
          query:
            'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state reviewDecision headRefOid}}}',
          variables: { owner, name, number },
        },
      },
      slug,
    );
    if (result.errors?.length)
      throw new AppError(result.errors.map((e) => e.message).join('; '), 502);
    const p = result.data.repository.pullRequest;
    return {
      state:
        p.state === 'MERGED'
          ? ('merged' as const)
          : p.state === 'CLOSED'
            ? ('closed' as const)
            : ('open' as const),
      headSha: p.headRefOid,
      decision:
        p.reviewDecision === 'APPROVED'
          ? ('approved' as const)
          : p.reviewDecision === 'CHANGES_REQUESTED'
            ? ('changes_requested' as const)
            : p.reviewDecision === 'REVIEW_REQUIRED'
              ? ('review_required' as const)
              : ('unknown' as const),
    };
  }
  async findPullRequest(slug: string, branch: string, base?: string) {
    const rows = await this.api<{ number: number }[]>(
      `repos/${slug}/pulls?state=all&head=${encodeURIComponent(slug.split('/')[0] + ':' + branch)}${base ? `&base=${encodeURIComponent(base)}` : ''}&per_page=100`,
    );
    return rows[0] ? this.pull(slug, rows[0].number) : undefined;
  }
  async createPullRequest(
    slug: string,
    input: { head: string; base: string; title: string; body: string },
  ) {
    const created = await this.api<{ number: number }>(`repos/${slug}/pulls`, {
      method: 'POST',
      body: input,
    });
    return this.pull(slug, created.number);
  }
  user(slug?: string) {
    return this.api<{ login: string }>('user', undefined, slug);
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
    const viewer = await this.user(slug);
    return this.summarizeReactions(await this.reactionRows(slug, commentId), viewer.login);
  }
  private graphReactionGroups(
    groups: { content: string; viewerHasReacted: boolean; reactors: { totalCount: number } }[] = [],
  ): ReviewReaction[] {
    return groups.flatMap((g) => {
      const content =
        g.content === 'THUMBS_UP'
          ? '+1'
          : g.content === 'THUMBS_DOWN'
            ? '-1'
            : g.content.toLowerCase();
      return REACTION_CONTENTS.includes(content as ReactionContent) && g.reactors.totalCount > 0
        ? [
            {
              content: content as ReactionContent,
              count: g.reactors.totalCount,
              viewerHasReacted: g.viewerHasReacted,
            },
          ]
        : [];
    });
  }
  async reactDiscussion(
    slug: string,
    number: number,
    id: string,
    content: ReactionContent,
    active: boolean,
  ): Promise<ReviewReaction[]> {
    const [kind, value] = id.split(':');
    if (!/^(comment|review):[1-9]\d*$/.test(id))
      throw new AppError(t('Message not found. Refresh the replies.'), 404);
    const endpoint =
      kind === 'review'
        ? `repos/${slug}/pulls/${number}/reviews/${value}`
        : `repos/${slug}/issues/comments/${value}`;
    const node = await this.api<{ node_id: string }>(endpoint);
    const action = active ? 'addReaction' : 'removeReaction';
    const result = await this.api<{
      errors?: { message: string }[];
      data?: Record<string, { reactionGroups: Parameters<GitHub['graphReactionGroups']>[0] }>;
    }>(
      'graphql',
      {
        method: 'POST',
        body: {
          query: `mutation($id:ID!,$content:ReactionContent!){${action}(input:{subjectId:$id,content:$content}){reactionGroups{content viewerHasReacted reactors{totalCount}}}}`,
          variables: {
            id: node.node_id,
            content:
              content === '+1'
                ? 'THUMBS_UP'
                : content === '-1'
                  ? 'THUMBS_DOWN'
                  : content.toUpperCase(),
          },
        },
      },
      slug,
    );
    if (result.errors?.length || !result.data?.[action])
      throw new AppError(
        result.errors?.map((e) => e.message).join('; ') || t('GitHub reactions are unavailable.'),
        502,
      );
    return this.graphReactionGroups(result.data[action].reactionGroups);
  }
  async replyDiscussion(
    slug: string,
    number: number,
    root: ReviewDiscussion,
    body: string,
  ): Promise<Omit<ReviewDiscussion, 'repoId'>> {
    const row = await this.api<{
      id: number;
      body: string;
      html_url: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    }>(`repos/${slug}/issues/${number}/comments`, {
      method: 'POST',
      body: {
        body: `<!-- reviewer-reply:${root.id} -->\n@${root.author} [${t('Reply')}](${root.url})\n\n${body}`,
      },
    });
    return {
      id: `comment:${row.id}`,
      replyTo: root.id,
      body: row.body.replace(REPLY_HEADER, ''),
      url: row.html_url,
      author: row.user.login,
      at: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async setCommentReaction(
    slug: string,
    commentId: number,
    content: ReactionContent,
    active: boolean,
  ): Promise<ReviewReaction[]> {
    const viewer = await this.user(slug);
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
      diff_hunk?: string;
      reactions?: Partial<Record<ReactionContent, number>>;
      node_id?: string;
    };
    const result: Omit<ReviewDiscussion, 'repoId'>[] = [];
    const generalNodes = new Map<string, string>();
    for (const [kind, endpoint] of [
      ['comment', `repos/${slug}/issues/${number}/comments`],
      ['inline', `repos/${slug}/pulls/${number}/comments`],
      ['review', `repos/${slug}/pulls/${number}/reviews`],
    ]) {
      for (let page = 1; ; page++) {
        const rows = await this.api<Comment[]>(`${endpoint}?per_page=100&page=${page}`);
        for (const row of rows)
          if (row.body) {
            if (kind !== 'inline' && row.node_id)
              generalNodes.set(row.node_id, `${kind}:${row.id}`);
            const reply = kind === 'comment' ? REPLY_HEADER.exec(row.body) : null;
            result.push({
              id: `${kind}:${row.id}`,
              body: reply ? row.body.slice(reply[0].length) : row.body,
              ...(reply ? { replyTo: reply[1] } : {}),
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
                    ...(row.diff_hunk ? { diffHunk: row.diff_hunk } : {}),
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
          }
        if (rows.length < 100) break;
      }
    }
    const nodes = [...generalNodes.keys()];
    for (let i = 0; i < nodes.length; i += 100) {
      try {
        const response = await this.api<{
          data?: {
            nodes: ({
              id: string;
              reactionGroups?: Parameters<GitHub['graphReactionGroups']>[0];
            } | null)[];
          };
        }>(
          'graphql',
          {
            method: 'POST',
            body: {
              query:
                'query($ids:[ID!]!){nodes(ids:$ids){id ... on Reactable{reactionGroups{content viewerHasReacted reactors{totalCount}}}}}',
              variables: { ids: nodes.slice(i, i + 100) },
            },
          },
          slug,
        );
        for (const node of response.data?.nodes ?? []) {
          const comment = node && result.find((c) => c.id === generalNodes.get(node.id));
          if (comment && node?.reactionGroups)
            comment.reactions = this.graphReactionGroups(node.reactionGroups);
        }
      } catch {
        /* Discussion text remains available if reaction loading is unavailable. */
      }
    }
    const withReactions = result.filter(
      (comment) => comment.id.startsWith('inline:') && comment.reactions?.length,
    );
    if (withReactions.length) {
      const login = await this.user(slug)
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
/**
 * GitHub has no threads for conversation comments, so a reply is a new comment that starts with a
 * hidden link to its root and a mention for readers on GitHub; in the app it sits in the thread.
 */
const REPLY_HEADER =
  /^<!-- reviewer-reply:((?:comment|review):[1-9]\d*) -->\n(?:@[\w-]+ \[[^\]\n]*\]\([^)\n]*\)\n\n)?/;
export function githubSlug(remote: string): string {
  const value = remote.trim().replace(/\.git$/, '');
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/.exec(
      value,
    );
  if (!match) throw new AppError(t('An origin on github.com is required (HTTPS or SSH).'));
  return match[1];
}

/** Resolve SSH Host aliases locally; -G prints configuration without connecting. */
export async function githubRemoteSlug(
  remote: string,
  configuration = (host: string) => command('ssh', ['-G', host], { timeout: 5000 }),
): Promise<string> {
  try {
    return githubSlug(remote);
  } catch {
    /* May be an SSH alias. */
  }
  const match = /^(?:git@([\w.-]+):|ssh:\/\/git@([\w.-]+)\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
    remote.trim(),
  );
  if (!match) throw new AppError(t('An origin on github.com is required (HTTPS or SSH).'));
  const host = match[1] ?? match[2];
  if (host.startsWith('-')) throw new AppError(t('Invalid SSH host.'));
  const config = await configuration(host);
  const hostname = config.match(/^hostname\s+(\S+)\s*$/im)?.[1]?.toLowerCase();
  if (hostname !== 'github.com')
    throw new AppError(t('The SSH alias does not point to github.com.'));
  return githubSlug(`git@github.com:${match[3]}`);
}
