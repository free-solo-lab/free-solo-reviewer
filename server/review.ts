import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  evidenceSchema,
  type ReviewDraft,
  type ReviewSession,
  type Snapshot,
} from '../shared/model.js';
import { GitHubApiError, type GitHubGateway, type ReviewPayload } from './github.js';
import { inlineLocation, readSource } from './repository.js';
import { Store } from './store.js';
import { AppError } from './process.js';
export const draftInputSchema = z.object({
  headSha: z.string(),
  body: z.string().max(60_000),
  action: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
  comments: z
    .array(
      z.object({
        id: z.string(),
        body: z.string().min(1).max(20_000),
        evidence: evidenceSchema.nullable(),
        selected: z.boolean(),
      }),
    )
    .max(100),
});
export class ReviewManager {
  private locks = new Set<string>();
  constructor(
    private store: Store,
    private github: GitHubGateway,
  ) {}
  get(session: ReviewSession, snapshot: Snapshot): ReviewDraft {
    return (
      this.store.draft(session.id, snapshot.id) ?? {
        sessionId: session.id,
        snapshotId: snapshot.id,
        headSha: snapshot.headSha,
        body: '',
        action: 'COMMENT',
        comments: [],
        state: 'draft',
        attempt: null,
        submission: null,
      }
    );
  }
  save(session: ReviewSession, snapshot: Snapshot, input: unknown) {
    if (this.locks.has(`${session.id}:${snapshot.id}`))
      throw new AppError('Отправка уже выполняется.', 409);
    const fields = draftInputSchema.parse(input);
    const old = this.get(session, snapshot);
    if (old.state !== 'draft')
      throw new AppError('Отправленное или неопределённое ревью нельзя редактировать.', 409);
    if (fields.headSha !== snapshot.headSha)
      throw new AppError('Черновик относится к другому коммиту.', 409);
    const draft = { ...old, ...fields };
    this.store.saveDraft(draft);
    return draft;
  }
  async reconcile(session: ReviewSession, snapshot: Snapshot) {
    const draft = this.get(session, snapshot);
    if (draft.state === 'submitted' || !draft.attempt || !snapshot.pr) return draft;
    const user = await this.github.user();
    const found = (await this.github.reviews(snapshot.slug, snapshot.pr.number)).find(
      (r) =>
        r.user.login === user.login &&
        r.commit_id === draft.headSha &&
        r.body.includes(draft.attempt!.marker) &&
        r.state !== 'PENDING',
    );
    if (found) {
      draft.state = 'submitted';
      draft.submission = { id: found.id, url: found.html_url, at: new Date().toISOString() };
      this.store.saveDraft(draft);
    }
    return draft;
  }
  async publish(session: ReviewSession, snapshot: Snapshot) {
    if (!snapshot.pr) throw new AppError('Для контекстного репозитория нет PR.');
    const key = `${session.id}:${snapshot.id}`;
    if (this.locks.has(key)) throw new AppError('Отправка уже выполняется.', 409);
    this.locks.add(key);
    try {
      let draft = this.get(session, snapshot);
      if (draft.state === 'submitted') return draft;
      if (draft.state === 'uncertain' || draft.state === 'submitting') {
        draft = await this.reconcile(session, snapshot);
        if (draft.state === 'submitted') return draft;
        throw new AppError(
          'Результат предыдущей отправки неизвестен. Проверьте GitHub и повторите сверку; повторная публикация заблокирована во избежание дубля.',
          409,
        );
      }
      const current = await this.github.pull(snapshot.slug, snapshot.pr.number);
      if (current.headRefOid !== snapshot.headSha || draft.headSha !== snapshot.headSha)
        throw new AppError(
          'В PR появились новые коммиты. Обновите снимки и перепроверьте комментарии.',
          409,
        );
      const user = await this.github.user();
      if (!(await this.github.permission(snapshot.slug)))
        throw new AppError('GitHub не подтвердил доступ к репозиторию.', 403);
      if (current.author.login === user.login && draft.action !== 'COMMENT')
        throw new AppError(
          'GitHub не разрешает approve/request changes для собственного PR. Выберите Comment.',
          403,
        );
      const comments: ReviewPayload['comments'] = [];
      const general: string[] = [];
      for (const comment of draft.comments.filter((c) => c.selected)) {
        if (!comment.body.trim()) throw new AppError('Пустой комментарий.');
        if (comment.evidence) {
          const owner = session.snapshots.find((s) => s.repoId === comment.evidence!.repoId);
          if (!owner) throw new AppError('Репозиторий комментария отсутствует.');
          const text = await readSource(owner, comment.evidence);
          if (
            comment.evidence.endLine < comment.evidence.startLine ||
            comment.evidence.endLine > text.split('\n').length
          )
            throw new AppError('Недопустимые строки комментария.');
          const location = inlineLocation(snapshot, comment.evidence);
          if (location) comments.push({ ...location, body: comment.body });
          else
            general.push(
              `${comment.body}\n\nКонтекст: ${owner.repoName}/${comment.evidence.path}:${comment.evidence.startLine} (${comment.evidence.side})`,
            );
        } else general.push(comment.body);
      }
      const body = [draft.body.trim(), ...general].filter(Boolean).join('\n\n---\n\n');
      if (draft.action !== 'APPROVE' && !body && !comments.length)
        throw new AppError('Добавьте текст или комментарии к ревью.');
      if (body.length > 60_000)
        throw new AppError('Общий текст ревью превышает 60 000 символов. Сократите комментарии.');
      const marker = `<!-- free-solo-review:${randomUUID()} -->`;
      const payload: ReviewPayload = {
        commit_id: snapshot.headSha,
        event: draft.action,
        body: [body, marker].filter(Boolean).join('\n\n'),
        comments,
      };
      draft.state = 'submitting';
      draft.attempt = { marker, at: new Date().toISOString(), payload };
      this.store.saveDraft(draft);
      try {
        const response = await this.github.submit(snapshot.slug, snapshot.pr.number, payload);
        draft.state = 'submitted';
        draft.submission = {
          id: response.id,
          url: response.html_url,
          at: new Date().toISOString(),
        };
        this.store.saveDraft(draft);
        return draft;
      } catch (error) {
        if (error instanceof GitHubApiError) {
          draft.state = 'draft';
          draft.attempt = null;
          this.store.saveDraft(draft);
          throw new AppError(
            `GitHub отклонил ревью: ${error.message}. Черновик доступен для исправления.`,
            error.httpStatus,
          );
        }
        draft.state = 'uncertain';
        this.store.saveDraft(draft);
        try {
          draft = await this.reconcile(session, snapshot);
        } catch {
          /* Keep persisted uncertainty if GitHub is unavailable. */
        }
        if (draft.state === 'submitted') return draft;
        throw new AppError(
          'GitHub не подтвердил результат отправки. Черновик сохранён; выполните сверку с GitHub. Повторная публикация заблокирована.',
          502,
        );
      }
    } finally {
      this.locks.delete(key);
    }
  }
}
