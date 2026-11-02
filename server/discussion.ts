import type { ReactionContent } from '../shared/reactions.js';
import type { ReviewDiscussion } from '../shared/model.js';
import type { GitHubGateway } from './github.js';
import { Store } from './store.js';
import { AppError } from './process.js';

export class Discussions {
  constructor(
    private store: Store,
    private github: GitHubGateway,
  ) {}
  async refresh(sessionId: string) {
    const session = this.store.session(sessionId);
    if (!session) throw new AppError('Сессия не найдена.', 404);
    if (!this.github.discussion)
      return { comments: session.threadDiscussion ?? session.discussion ?? [], warnings: [] };
    const before = new Map(
      (session.threadDiscussion ?? session.discussion ?? []).map((comment) => [
        `${comment.repoId}:${comment.id}`,
        JSON.stringify(comment),
      ]),
    );
    const loaded: ReviewDiscussion[] = [],
      succeeded = new Set<string>(),
      warnings: string[] = [];
    for (const snapshot of session.snapshots.filter((snapshot) => snapshot.pr)) {
      try {
        loaded.push(
          ...(await this.github.discussion(snapshot.slug, snapshot.pr!.number)).map((comment) => ({
            ...comment,
            repoId: snapshot.repoId,
          })),
        );
        succeeded.add(snapshot.repoId);
      } catch {
        warnings.push(
          `Не удалось обновить ответы: ${snapshot.repoName}. Сохранённые обсуждения доступны.`,
        );
      }
    }
    // Re-read after network I/O: never replace an analysis or a concurrently saved reply.
    const current = this.store.session(sessionId);
    if (!current) throw new AppError('Сессия не найдена.', 404);
    const preserved = (current.threadDiscussion ?? current.discussion ?? []).filter(
      (comment) =>
        !succeeded.has(comment.repoId) ||
        before.get(`${comment.repoId}:${comment.id}`) !== JSON.stringify(comment),
    );
    const merged = new Map(loaded.map((comment) => [`${comment.repoId}:${comment.id}`, comment]));
    for (const comment of preserved) merged.set(`${comment.repoId}:${comment.id}`, comment);
    current.threadDiscussion = [...merged.values()];
    this.store.saveSession(current);
    return { comments: current.threadDiscussion, warnings };
  }
  async react(
    sessionId: string,
    repoId: string,
    commentId: string,
    content: ReactionContent,
    active: boolean,
  ) {
    const session = this.store.session(sessionId);
    if (!session) throw new AppError('Сессия не найдена.', 404);
    const snapshot = session.snapshots.find(
      (snapshot) => snapshot.repoId === repoId && snapshot.pr,
    );
    const comment = (session.threadDiscussion ?? session.discussion)?.find(
      (comment) => comment.repoId === repoId && comment.id === commentId,
    );
    if (!snapshot || !comment || !/^inline:[1-9]\d*$/.test(commentId))
      throw new AppError('Сообщение не найдено. Обновите ответы.', 404);
    if (!this.github.setCommentReaction) throw new AppError('Реакции GitHub недоступны.', 503);
    const reactions = await this.github.setCommentReaction(
      snapshot.slug,
      Number(commentId.slice(7)),
      content,
      active,
    );
    const current = this.store.session(sessionId);
    const latest =
      (current?.threadDiscussion ?? current?.discussion)?.find(
        (item) => item.repoId === repoId && item.id === commentId,
      ) ?? comment;
    const updated = { ...latest, reactions };
    if (current) {
      current.threadDiscussion = (current.threadDiscussion ?? current.discussion ?? []).map(
        (comment) =>
          comment.repoId === repoId && comment.id === commentId
            ? { ...comment, reactions }
            : comment,
      );
      this.store.saveSession(current);
    }
    return updated;
  }
  async reply(sessionId: string, repoId: string, rootId: string, body: string) {
    const session = this.store.session(sessionId);
    if (!session) throw new AppError('Сессия не найдена.', 404);
    const snapshot = session.snapshots.find(
      (snapshot) => snapshot.repoId === repoId && snapshot.pr,
    );
    const root = (session.threadDiscussion ?? session.discussion)?.find(
      (comment) => comment.repoId === repoId && comment.id === rootId && !comment.replyTo,
    );
    if (!snapshot || !root || !/^inline:[1-9]\d*$/.test(rootId))
      throw new AppError('Ветка обсуждения не найдена. Обновите ответы.', 404);
    if (!this.github.reply) throw new AppError('Ответы GitHub недоступны.', 503);
    const reply = {
      ...(await this.github.reply(
        snapshot.slug,
        snapshot.pr!.number,
        Number(rootId.slice(7)),
        body,
      )),
      repoId,
    };
    const current = this.store.session(sessionId);
    if (current) {
      current.threadDiscussion = [
        ...(current.threadDiscussion ?? current.discussion ?? []).filter(
          (comment) => comment.repoId !== repoId || comment.id !== reply.id,
        ),
        reply,
      ];
      this.store.saveSession(current);
    }
    return reply;
  }
}
