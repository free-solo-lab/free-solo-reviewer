import React, { lazy, Suspense, useState, useRef, useEffect, useMemo } from 'react';
import type {
  Repository,
  PullRequest,
  ReviewSession,
  Evidence,
  Snapshot,
  Scenario,
  Contract,
  ChangedFile,
  SourceIndex,
  DraftComment,
} from '../shared/model';
import { touchesReviewChanges, type ScenarioChange } from '../shared/scenario-changes';
import type { ReactionContent } from '../shared/reactions';
import type { ReviewUpdate } from '../shared/model';
import { discussionAtLine, type CodeDiscussion } from '../shared/discussion-threads';
import { DiscussionThread } from './DiscussionThread';
import type { MethodView } from '../shared/viewed-methods';
import { commentsAtLine } from '../shared/review-comments';
import { Markdown } from './Markdown';
import { serviceGroups } from '../shared/graph';
import { databaseOwner } from '../shared/sequence';
import { sourceMethodRows } from '../shared/source-methods';
import type { CodeComparison } from '../shared/code-comparison';
import { sourceDiffRows, reviewDiffRows } from '../shared/source-diff';
import type { MethodLink } from '../shared/code-navigation';
import { sequenceParticipantLayout, type SequenceParticipant } from '../shared/sequence-view';
import { sequenceMethod } from '../shared/sequence-method';
import type { SqlPreview } from '../shared/sql-preview';
import { sequenceLayout, type TransactionRegion } from '../shared/transactions';
import { api } from './api';
import { CodeTokens, CodeLanguage, CodeBlock } from './Code';
import { SequenceCanvas } from './SequenceCanvas';
import { highlightLines, highlightDiff, languageForPath } from './syntax';
const Swagger = lazy(() =>
  import('swagger-ui-react').then((m) => ({
    default: m.default as React.ComponentType<
      React.ComponentProps<typeof m.default> & { validatorUrl: null }
    >,
  })),
);
import 'swagger-ui-react/swagger-ui.css';
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-glyph">⌁</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Gaps({ gaps }: { gaps: string[] }) {
  return gaps.length > 0 ? (
    <details className="gaps panel">
      <summary>
        △ Неизвестное и ограничения <span>{gaps.length}</span>
      </summary>
      <ul>
        {gaps.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    </details>
  ) : null;
}
export function commentLocation(snapshot: Snapshot, e: Evidence | null) {
  if (!e) return 'В общем описании ревью';
  const f = snapshot.files.find(
    (f) => (e.side === 'head' ? f.path : (f.oldPath ?? f.path)) === e.path,
  );
  const inline =
    e.repoId === snapshot.repoId &&
    f &&
    (e.side === 'head' ? f.addedLines : f.removedLines).includes(e.startLine);
  return inline
    ? `Inline · ${e.path}:${e.startLine} · ${e.side === 'head' ? 'RIGHT' : 'LEFT'}`
    : `В общем описании · ${e.path}:${e.startLine} (${e.side})`;
}
export function Sequence({
  scenario,
  name,
  onSelect,
  transactions = [],
  participants,
  collapsed = new Set<string>(),
  onToggleService,
  internalCount = new Map<string, number>(),
  indexes = [],
  snapshots = [],
  onSqlSelect,
  description,
  revisionChange,
  revisionFiles = [],
}: {
  revisionChange?: ScenarioChange;
  revisionFiles?: ReviewUpdate['changes'];
  description?: React.ReactNode;
  onSqlSelect?: (evidence: Evidence) => void;
  indexes?: SourceIndex[];
  snapshots?: Snapshot[];
  transactions?: TransactionRegion[];
  participants?: SequenceParticipant[];
  collapsed?: ReadonlySet<string>;
  onToggleService?: (id: string) => void;
  internalCount?: ReadonlyMap<string, number>;
  scenario: Scenario;
  name: (id: string) => string;
  onSelect: (refs: Evidence[]) => void;
}) {
  const services = participants?.map((p) => p.id) ?? serviceGroups(scenario).flat();
  const participantLayout = participants ? sequenceParticipantLayout(participants) : null;
  const width = participantLayout?.width ?? Math.max(720, services.length * 240);
  const layout = sequenceLayout(
    scenario,
    transactions,
    participantLayout?.hasClasses ? 220 : participants ? 166 : 126,
  );
  const height = layout.height;
  const x = (id: string) =>
    participantLayout?.positions.get(id)?.x ?? 110 + services.indexOf(id) * 240;
  const participantNodes = (headerOnly: boolean) =>
    services.map((id) => {
      const participant = participants?.find((p) => p.id === id);
      const position = participantLayout?.positions.get(id);
      const headerY = position?.y ?? 12;
      const headerWidth = position?.width ?? 190;
      const hasChildren =
        participant?.kind === 'service' &&
        participants?.some((p) => p.owner === id && p.kind === 'class');
      const hasServiceCalls = scenario.steps.some((s) => s.from === id || s.to === id);
      const isToggle = participant?.kind === 'service' && (internalCount.get(id) ?? 0) > 0;
      const isCollapsed = collapsed.has(id);
      const classSource = participant?.kind === 'class' ? participant.evidence : undefined;
      const activate = isToggle
        ? () => onToggleService?.(id)
        : classSource
          ? () => onSelect([classSource])
          : undefined;
      const label = `${isToggle ? (isCollapsed ? '▸ ' : '▾ ') : ''}${name(id)}`;
      return (
        <g
          key={id}
          className={
            participant?.kind === 'class'
              ? 'class-participant'
              : participant?.kind === 'external'
                ? 'external-participant'
                : undefined
          }
        >
          {headerOnly && participant?.kind === 'class' && (
            <line x1={x(id)} y1={58} x2={x(id)} y2={headerY} className="lifeline class-connector" />
          )}
          {headerOnly && (
            <g
              transform={`translate(0, ${headerY - 12})`}
              className={isToggle ? 'owner-toggle' : classSource ? 'class-code-link' : undefined}
              role={activate ? 'button' : undefined}
              tabIndex={activate ? 0 : undefined}
              aria-label={
                isToggle
                  ? `${isCollapsed ? 'Развернуть' : 'Свернуть'} сервис ${name(id)}`
                  : classSource
                    ? `Открыть весь код класса ${name(id)}`
                    : undefined
              }
              aria-expanded={isToggle ? !isCollapsed : undefined}
              onClick={activate}
              onKeyDown={
                activate
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activate();
                      }
                    }
                  : undefined
              }
            >
              {databaseOwner(id) ? (
                <g className="database-participant" transform="translate(0, 6)">
                  <path
                    d={`M${x(id) - 95},22 C${x(id) - 95},1 ${x(id) + 95},1 ${x(id) + 95},22 V46 C${x(id) + 95},67 ${x(id) - 95},67 ${x(id) - 95},46 Z`}
                  />
                  <ellipse cx={x(id)} cy={22} rx={95} ry={16} />
                </g>
              ) : (
                <rect
                  className="participant"
                  x={x(id) - headerWidth / 2}
                  y={12}
                  width={headerWidth}
                  height={46}
                  rx={7}
                />
              )}
              <title>
                {isToggle
                  ? `${name(id)} · нажмите для изменения детализации`
                  : classSource
                    ? `${name(id)} · открыть весь код класса`
                    : name(id)}
              </title>
              <text x={x(id)} y={40} textAnchor="middle" className="participant-name">
                {label
                  .match(/.{1,29}/g)
                  ?.slice(0, 2)
                  .map((line, i) => (
                    <tspan key={i} x={x(id)} dy={i ? 12 : 0}>
                      {line}
                    </tspan>
                  ))}
              </text>
            </g>
          )}
          {!headerOnly && (!hasChildren || hasServiceCalls) && (
            <line
              x1={x(id)}
              y1={headerY + (databaseOwner(id) ? 56 : 46)}
              x2={x(id)}
              y2={height}
              className="lifeline"
            />
          )}
        </g>
      );
    });
  return (
    <div className="sequence-scroll">
      {description}
      <SequenceCanvas
        width={width}
        height={Math.max(height, 230)}
        headerHeight={participantLayout?.hasClasses ? 154 : 78}
        header={participantNodes(true)}
        topInset={12}
      >
        <svg
          className="sequence-body"
          role="group"
          aria-label={`Sequence: ${scenario.title}`}
          width={width}
          height={Math.max(height, 230)}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.frames.map((frame) => {
            const frameMembers = frame.boundaryParticipants;
            const columns = frameMembers.map(x);
            const padding = Math.min(...columns) === Math.max(...columns) ? 90 : 26;
            const left = Math.max(16, Math.min(...columns) - padding + frame.lane * 5);
            const right = Math.max(...columns) + padding - frame.lane * 5;
            const frameWidth = Math.max(90, right - left);
            const label =
              frame.mode === 'non-transactional'
                ? 'БЕЗ TX'
                : frame.mode === 'uncertain'
                  ? 'TX ?'
                  : 'TX';
            return (
              <g className={`transaction-region ${frame.mode}`} key={frame.id}>
                <rect
                  className="transaction-region-fill"
                  x={left}
                  y={frame.top}
                  width={frameWidth}
                  height={frame.bottom - frame.top}
                  rx={6}
                />
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`Граница транзакции: ${frame.title} · ${frame.propagation}`}
                  onClick={() => onSelect(frame.evidence)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(frame.evidence);
                    }
                  }}
                >
                  <rect
                    className="transaction-region-label"
                    x={left}
                    y={frame.top}
                    width={frameWidth}
                    height={24}
                    rx={5}
                  />
                  <text x={left + 9} y={frame.top + 16}>
                    {`${label} · ${frame.propagation} · ${frame.title}`.length >
                    Math.floor((frameWidth - 18) / 6)
                      ? `${`${label} · ${frame.propagation} · ${frame.title}`.slice(0, Math.max(8, Math.floor((frameWidth - 18) / 6) - 1))}…`
                      : `${label} · ${frame.propagation} · ${frame.title}`}
                  </text>
                  <title>
                    {frame.title} — {frame.description} {frame.rollback}
                  </title>
                </g>
              </g>
            );
          })}
          {participantNodes(false)}
          {scenario.steps.map((s, i) => {
            const y = layout.rows[i];
            const self = s.from === s.to;
            const method = sequenceMethod(s, indexes, snapshots);
            const sql = s.kind === 'database';
            const sqlEvidence =
              method.evidence ??
              (indexes.length === 0
                ? (s.evidence.find((ref) => /Repository|Dao|DAO/.test(ref.path)) ?? s.evidence[0])
                : undefined);
            const openMethod = () =>
              sql && onSqlSelect && sqlEvidence
                ? onSqlSelect(sqlEvidence)
                : onSelect(method.evidence ? [method.evidence] : s.evidence);
            const label = sql
              ? `${s.label.match(/\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i)?.[1]?.toUpperCase() ?? 'SQL'} · открыть запрос`
              : method.label;
            return (
              <g
                key={s.id}
                className={`sequence-step ${s.change} ${s.kind} ${revisionChange && (revisionChange.steps.has(s.id) || touchesReviewChanges(s.evidence, revisionFiles)) ? `review-step-${revisionChange.steps.get(s.id) ?? 'modified'}` : ''}`}
                onClick={openMethod}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openMethod();
                }}
                tabIndex={0}
                role="button"
                aria-label={sql ? `Открыть SQL: ${s.label}` : `Открыть вызов: ${s.label}`}
              >
                <rect
                  className="step-hit"
                  x={Math.min(x(s.from), x(s.to)) - 12}
                  y={y - 42}
                  width={Math.max(Math.abs(x(s.to) - x(s.from)) + 24, 150)}
                  height={96}
                />
                {self ? (
                  <path d={`M${x(s.from)},${y} h70 v20 h-70`} markerEnd="url(#arrow)" fill="none" />
                ) : (
                  <line x1={x(s.from)} x2={x(s.to)} y1={y} y2={y} markerEnd="url(#arrow)" />
                )}
                <title>{label}</title>
                <text
                  x={self ? x(s.from) + 12 : (x(s.from) + x(s.to)) / 2}
                  y={y - 28}
                  textAnchor={self ? 'start' : 'middle'}
                >
                  {`${i + 1}. ${label}`
                    .match(/.{1,48}/g)
                    ?.slice(0, 2)
                    .map((line, n) => (
                      <tspan
                        key={n}
                        x={self ? x(s.from) + 12 : (x(s.from) + x(s.to)) / 2}
                        dy={n ? 14 : 0}
                      >
                        {line}
                      </tspan>
                    ))}
                </text>
                {!sql && (method.inputs.length > 0 || method.outputs.length > 0) && (
                  <text
                    className="sequence-models"
                    x={self ? x(s.from) + 12 : (x(s.from) + x(s.to)) / 2}
                    y={y + (self ? 38 : 22)}
                    textAnchor={self ? 'start' : 'middle'}
                  >
                    {[
                      { label: 'Вход', models: method.inputs },
                      { label: 'Выход', models: method.outputs },
                    ]
                      .filter((group) => group.models.length)
                      .map((group, n) => (
                        <tspan
                          key={group.label}
                          x={self ? x(s.from) + 12 : (x(s.from) + x(s.to)) / 2}
                          dy={n ? 16 : 0}
                        >
                          {group.label}:{' '}
                          {group.models.map((model, j) => (
                            <React.Fragment key={`${model.name}:${j}`}>
                              {j > 0 ? ', ' : ''}
                              <tspan
                                className={model.evidence ? 'sequence-model-link' : undefined}
                                role={model.evidence ? 'link' : undefined}
                                tabIndex={model.evidence ? 0 : undefined}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (model.evidence) onSelect([model.evidence]);
                                }}
                                onKeyDown={(event) => {
                                  event.stopPropagation();
                                  if (
                                    model.evidence &&
                                    (event.key === 'Enter' || event.key === ' ')
                                  ) {
                                    event.preventDefault();
                                    onSelect([model.evidence]);
                                  }
                                }}
                              >
                                {model.name}
                                {model.evidence && (
                                  <title>Открыть модель: {model.evidence.path}</title>
                                )}
                              </tspan>
                            </React.Fragment>
                          ))}
                        </tspan>
                      ))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </SequenceCanvas>
    </div>
  );
}
function CodeComments({
  comments,
  onDelete,
  deletableIds,
}: {
  comments: DraftComment[];
  onDelete?: (id: string) => void;
  deletableIds?: ReadonlySet<string>;
}) {
  if (!comments.length) return null;
  return (
    <div className="code-comment-thread" role="region" aria-label="Комментарии к коду">
      {comments.map((comment) => (
        <article className="code-comment-card" key={comment.id}>
          <div className="code-comment-heading">
            <strong>Ваш комментарий</strong>
            <span>
              {comment.evidence?.startLine === comment.evidence?.endLine
                ? `Строка ${comment.evidence?.startLine}`
                : `Строки ${comment.evidence?.startLine}–${comment.evidence?.endLine}`}
            </span>
            {!comment.selected && <small>Не включён в отправку</small>}
            {onDelete && (!deletableIds || deletableIds.has(comment.id)) && (
              <button
                className="code-comment-delete"
                aria-label="Удалить комментарий"
                title="Удалить комментарий"
                onClick={() => onDelete(comment.id)}
              >
                ×
              </button>
            )}
          </div>
          <Markdown>{comment.body}</Markdown>
        </article>
      ))}
    </div>
  );
}

export function Diff({
  patch,
  repoId,
  path,
  oldPath,
  onSelect,
  comments = [],
}: {
  patch: string;
  repoId: string;
  path: string;
  oldPath?: string;
  onSelect: (e: Evidence) => void;
  comments?: DraftComment[];
}) {
  const rows = useMemo(() => highlightDiff(patch, path, oldPath), [patch, path, oldPath]);
  return (
    <div className="diff-code syntax-light">
      {rows.map((row, i) => {
        if (row.kind === 'meta') return null;
        if (row.kind === 'hunk')
          return (
            <div className="diff-hunk" key={i}>
              {row.text}
            </div>
          );
        const changed = row.kind === 'addition' || row.kind === 'deletion';
        const line: Evidence = {
          repoId,
          side: row.kind === 'deletion' ? 'base' : 'head',
          path: row.kind === 'deletion' ? (oldPath ?? path) : path,
          startLine: row.kind === 'deletion' ? row.left! : row.right!,
          endLine: row.kind === 'deletion' ? row.left! : row.right!,
        };
        const threads = commentsAtLine(comments, line);
        if (row.kind === 'context' && row.left != null)
          threads.push(
            ...commentsAtLine(comments, {
              ...line,
              side: 'base',
              path: oldPath ?? path,
              startLine: row.left,
            }),
          );
        return (
          <React.Fragment key={i}>
            <button
              key={i}
              className={`diff-line ${row.kind}`}
              disabled={!changed}
              onClick={() =>
                onSelect({
                  repoId,
                  side: row.kind === 'deletion' ? 'base' : 'head',
                  path: row.kind === 'deletion' ? (oldPath ?? path) : path,
                  startLine: row.kind === 'deletion' ? row.left! : row.right!,
                  endLine: row.kind === 'deletion' ? row.left! : row.right!,
                })
              }
            >
              <span>{row.left}</span>
              <span>{row.right}</span>
              <code>
                <span className="diff-prefix">{row.text[0]}</span>
                <CodeTokens tokens={row.tokens} />
              </code>
              {changed && <em>＋</em>}
            </button>
            <CodeComments comments={threads} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function SourceCode({
  text,
  evidence,
  onSelect,
  links = [],
  onDefinition,
  visitId,
  position,
  viewportRef,
  changedFile,
  selection,
  commentEditor,
  comments = [],
  methods = [],
  methodPending = new Set<string>(),
  methodError = '',
  onMethodViewed,
  onDeleteComment,
  discussions = [],
  discussionSessionId = '',
  onDiscussionReply,
  onDiscussionReaction,
  comparison,
  previousComments = [],
  previousDiscussions = [],
  onHistoricalSource,
}: {
  comparison?: CodeComparison;
  previousComments?: DraftComment[];
  previousDiscussions?: CodeDiscussion[];
  onHistoricalSource?: (evidence: Evidence) => void;
  discussions?: CodeDiscussion[];
  discussionSessionId?: string;
  onDiscussionReply?: (repoId: string, rootId: string, body: string) => Promise<void>;
  onDiscussionReaction?: (
    repoId: string,
    commentId: string,
    content: ReactionContent,
    active: boolean,
  ) => Promise<void>;
  onDeleteComment?: (id: string) => void;
  methods?: MethodView[];
  methodPending?: Set<string>;
  methodError?: string;
  onMethodViewed?: (entry: MethodView, viewed: boolean) => void;
  comments?: DraftComment[];
  commentEditor?: React.ReactNode;
  changedFile?: ChangedFile;
  selection?: Evidence;
  links?: MethodLink[][];
  onDefinition?: (link: MethodLink) => void;
  visitId?: number;
  position?: { top: number; left: number };
  viewportRef?: React.MutableRefObject<HTMLDivElement | null>;
  text: string;
  evidence: Evidence;
  onSelect: (line: number, evidence?: Evidence) => void;
}) {
  const [expandedMethods, setExpandedMethods] = useState<Set<string>>(new Set());
  const [collapsedMethods, setCollapsedMethods] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpandedMethods(new Set());
    setCollapsedMethods(new Set());
  }, [evidence.repoId, evidence.side, evidence.path, visitId]);
  const isCollapsed = (entry: MethodView) =>
    !expandedMethods.has(entry.key) && (entry.viewed || collapsedMethods.has(entry.key));
  const toggleMethod = (entry: MethodView) => {
    const collapsed = isCollapsed(entry);
    setExpandedMethods((previous) => {
      const next = new Set(previous);
      if (collapsed) next.add(entry.key);
      else next.delete(entry.key);
      return next;
    });
    setCollapsedMethods((previous) => {
      const next = new Set(previous);
      if (collapsed) next.delete(entry.key);
      else next.add(entry.key);
      return next;
    });
  };
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragRange, setDragRange] = useState<Evidence | null>(null);
  const drag = useRef<{
    pointer: number;
    anchor: Evidence;
    range: Evidence;
    x: number;
    y: number;
    frame: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const stopDrag = () => {
    if (drag.current) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
  };
  useEffect(() => {
    stopDrag();
    setDragRange(null);
    return stopDrag;
  }, [visitId]);
  const activeSelection = dragRange ?? selection;
  const updateDrag = () => {
    const current = drag.current,
      container = ref.current;
    if (!current || !container) return;
    const box = container.getBoundingClientRect();
    const row = document
      .elementFromPoint(
        Math.max(box.left + 2, Math.min(box.right - 2, current.x)),
        Math.max(box.top + 2, Math.min(box.bottom - 2, current.y)),
      )
      ?.closest<HTMLElement>('.source-line');
    if (!row || !container.contains(row) || row.dataset.sourceSide !== current.anchor.side) return;
    const line = Number(row.dataset.sourceLine);
    if (!Number.isInteger(line) || line < 1) return;
    const range = {
      ...current.anchor,
      startLine: Math.min(current.anchor.startLine, line),
      endLine: Math.max(current.anchor.startLine, line),
    };
    if (range.startLine !== current.range.startLine || range.endLine !== current.range.endLine) {
      current.range = range;
      setDragRange(range);
    }
  };
  const dragScroll = () => {
    const current = drag.current,
      container = ref.current;
    if (!current || !container) return;
    const box = container.getBoundingClientRect();
    const speed =
      current.y < box.top + 36
        ? -Math.min(16, (box.top + 36 - current.y) / 3)
        : current.y > box.bottom - 36
          ? Math.min(16, (current.y - box.bottom + 36) / 3)
          : 0;
    if (speed) {
      container.scrollTop += speed;
      updateDrag();
    }
    current.frame = requestAnimationFrame(dragScroll);
  };
  const selectionAnchor = useRef<Evidence | null>(null);
  const editor = useRef<HTMLDivElement | null>(null);
  const select = (reference: Evidence, extend: boolean) => {
    const anchor = selectionAnchor.current;
    if (
      extend &&
      anchor &&
      anchor.repoId === reference.repoId &&
      anchor.side === reference.side &&
      anchor.path === reference.path
    ) {
      onSelect(reference.startLine, {
        ...reference,
        startLine: Math.min(anchor.startLine, reference.startLine),
        endLine: Math.max(anchor.startLine, reference.startLine),
      });
    } else {
      selectionAnchor.current = reference;
      onSelect(reference.startLine, reference);
    }
  };
  useEffect(() => {
    selectionAnchor.current = selection ? { ...selection, endLine: selection.startLine } : null;
  }, [visitId]);
  useEffect(() => {
    if (!dragRange) editor.current?.scrollIntoView({ block: 'nearest' });
  }, [
    selection?.side,
    selection?.path,
    selection?.startLine,
    selection?.endLine,
    visitId,
    !!dragRange,
  ]);
  const lines = useMemo(
    () => highlightLines(text, languageForPath(evidence.path)),
    [text, evidence.path],
  );
  const rows = useMemo(
    () =>
      comparison
        ? reviewDiffRows(text, evidence, comparison.file, comparison.previousPath)
        : sourceDiffRows(text, evidence, changedFile),
    [text, evidence.repoId, evidence.side, evidence.path, changedFile, comparison],
  );
  const methodRows = useMemo(() => sourceMethodRows(rows, methods), [rows, methods]);
  const priorComments = previousComments.filter(
    (comment) => !comments.some((current) => current.id === comment.id && current.evidence),
  );
  const priorDiscussions = previousDiscussions.filter(
    (thread) =>
      !discussions.some((current) => current.root.id === thread.root.id && current.evidence),
  );
  const currentDiscussions = discussions.filter(
    (thread) =>
      thread.evidence ||
      !priorDiscussions.some(
        (previous) => previous.root.id === thread.root.id && previous.evidence,
      ),
  );
  const rowComments = (row: (typeof rows)[number]) => {
    if (row.historical) return commentsAtLine(priorComments, row.evidence);
    const threads = commentsAtLine(comments, row.evidence);
    if (row.kind === 'context') {
      if (comparison && row.left != null)
        threads.push(
          ...commentsAtLine(priorComments, {
            ...row.evidence,
            side: 'head',
            path: comparison.previousPath,
            startLine: row.left,
          }),
        );
      else {
        const side = row.evidence.side === 'head' ? 'base' : 'head';
        const counterpart = side === 'base' ? row.left : row.right;
        if (counterpart != null)
          threads.push(
            ...commentsAtLine(comments, {
              ...row.evidence,
              side,
              path:
                side === 'base'
                  ? (changedFile?.oldPath ?? evidence.path)
                  : (changedFile?.path ?? evidence.path),
              startLine: counterpart,
            }),
          );
      }
    }
    return threads;
  };
  const rowDiscussions = (row: (typeof rows)[number]) => {
    if (row.historical) return discussionAtLine(priorDiscussions, row.evidence);
    const threads = discussionAtLine(currentDiscussions, row.evidence);
    if (row.kind === 'context') {
      if (comparison && row.left != null)
        threads.push(
          ...discussionAtLine(priorDiscussions, {
            ...row.evidence,
            side: 'head',
            path: comparison.previousPath,
            startLine: row.left,
          }),
        );
      else {
        const side = row.evidence.side === 'head' ? 'base' : 'head';
        const counterpart = side === 'base' ? row.left : row.right;
        if (counterpart != null)
          threads.push(
            ...discussionAtLine(currentDiscussions, {
              ...row.evidence,
              side,
              path:
                side === 'base'
                  ? (changedFile?.oldPath ?? evidence.path)
                  : (changedFile?.path ?? evidence.path),
              startLine: counterpart,
            }),
          );
      }
    }
    return threads.filter(
      (thread, i, all) => all.findIndex((other) => other.root.id === thread.root.id) === i,
    );
  };
  const placedThreadIds = new Set(rows.flatMap(rowDiscussions).map((thread) => thread.root.id));
  const unplacedThreads = [
    ...new Map(
      [...currentDiscussions, ...priorDiscussions]
        .filter((thread) => !placedThreadIds.has(thread.root.id))
        .map((thread) => [thread.root.id, thread]),
    ).values(),
  ];
  const methodsWithComments = new Set(
    methodRows
      .filter(
        (entry) =>
          entry.method && (rowComments(entry.row).length || rowDiscussions(entry.row).length),
      )
      .map((entry) => entry.method!.key),
  );
  const patchTokens = useMemo(
    () =>
      new Map(
        highlightDiff(
          changedFile?.patch ?? '',
          changedFile?.path ?? evidence.path,
          changedFile?.oldPath,
        )
          .filter((r) => r.kind === 'addition' || r.kind === 'deletion')
          .map((r) => [`${r.kind}:${r.kind === 'deletion' ? r.left : r.right}`, r.tokens]),
      ),
    [changedFile, evidence.path],
  );
  useEffect(() => {
    ref.current
      ?.querySelector(
        `[data-source-side="${evidence.side}"][data-source-line="${evidence.startLine}"]`,
      )
      ?.scrollIntoView({ block: 'center' });
    if (position && ref.current) {
      ref.current.scrollTop = position.top;
      ref.current.scrollLeft = position.left;
    }
  }, [evidence.repoId, evidence.side, evidence.path, visitId]);
  return (
    <>
      <div className="code-toolbar">
        <CodeLanguage path={evidence.path} />
        {methodError && <span role="alert">{methodError}</span>}
        <span className="source-diff-legend">
          <b>+ Добавлено</b> <b>− Удалено</b>
        </span>
        <span>Потяни за номер строки — выделить диапазон · ⌘-клик — определение</span>
      </div>
      <div
        className={`source-code syntax-light ${dragRange ? 'source-dragging' : ''}`}
        onPointerMove={(e) => {
          if (!drag.current || drag.current.pointer !== e.pointerId) return;
          drag.current.x = e.clientX;
          drag.current.y = e.clientY;
          updateDrag();
        }}
        onPointerUp={(e) => {
          const current = drag.current;
          if (!current || current.pointer !== e.pointerId) return;
          updateDrag();
          const range = current.range;
          stopDrag();
          setDragRange(null);
          selectionAnchor.current = current.anchor;
          onSelect(range.startLine, range);
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          stopDrag();
          setDragRange(null);
          suppressClick.current = false;
        }}
        onLostPointerCapture={() => {
          if (drag.current) {
            stopDrag();
            setDragRange(null);
          }
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        ref={(node) => {
          ref.current = node;
          if (viewportRef) viewportRef.current = node;
        }}
      >
        {!!unplacedThreads.length && (
          <details className="source-outdated-discussions" open>
            <summary>Обсуждения предыдущей версии или другой стороны диффа</summary>
            {unplacedThreads.map((thread) => (
              <DiscussionThread
                key={`${thread.root.repoId}:${thread.root.id}`}
                thread={thread}
                sessionId={discussionSessionId}
                onReply={onDiscussionReply}
                onReact={onDiscussionReaction}
              />
            ))}
          </details>
        )}
        {methodRows.map(({ row, method: methodEntry, methodStart }, i) => {
          const number = row.evidence.startLine;
          const folded = methodEntry && isCollapsed(methodEntry);
          if (folded && !methodStart) return null;
          const navigationTarget =
            !row.historical &&
            row.evidence.side === evidence.side &&
            row.evidence.path === evidence.path &&
            number >= evidence.startLine &&
            number <= evidence.endLine;
          const selected =
            !row.historical &&
            activeSelection &&
            row.evidence.side === activeSelection.side &&
            row.evidence.path === activeSelection.path &&
            number >= activeSelection.startLine &&
            number <= activeSelection.endLine;
          const tokens = row.native
            ? (lines[number - 1] ?? [])
            : (patchTokens.get(`${row.kind}:${number}`) ?? []);
          const threads = rowComments(row);
          return (
            <React.Fragment key={i}>
              {methodStart && methodEntry && (
                <div
                  className={`source-method-toolbar ${methodEntry.viewed ? 'viewed' : ''}`}
                  data-source-side={folded ? evidence.side : undefined}
                  data-source-line={folded ? number : undefined}
                >
                  <button
                    aria-expanded={!folded}
                    onClick={() => toggleMethod(methodEntry)}
                    title={methodEntry.method.signature}
                  >
                    {folded ? '▸' : '▾'} {methodEntry.method.name}()
                    {folded && (
                      <span> · {methodEntry.method.evidence.endLine - number + 1} строк</span>
                    )}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`${methodEntry.method.name}: просмотрен`}
                      checked={methodEntry.viewed}
                      disabled={methodPending.has(methodEntry.key)}
                      onChange={(event) => {
                        setExpandedMethods((previous) => {
                          const next = new Set(previous);
                          next.delete(methodEntry.key);
                          return next;
                        });
                        setCollapsedMethods((previous) => {
                          const next = new Set(previous);
                          next.delete(methodEntry.key);
                          return next;
                        });
                        onMethodViewed?.(methodEntry, event.target.checked);
                      }}
                    />{' '}
                    Просмотрен
                  </label>
                  {folded && methodsWithComments.has(methodEntry.key) && (
                    <button onClick={() => toggleMethod(methodEntry)}>Показать комментарии</button>
                  )}
                </div>
              )}
              {!folded && (
                <>
                  <div
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && e.key === 'Enter')
                        row.historical
                          ? onHistoricalSource?.(row.evidence)
                          : select(row.evidence, e.shiftKey);
                    }}
                    key={i}
                    data-source-side={row.historical ? 'previous' : row.evidence.side}
                    data-source-line={number}
                    className={`source-line ${row.kind} ${navigationTarget ? 'source-navigation-target' : ''} ${selected ? 'source-selected' : ''}`}
                    onPointerDown={(e) => {
                      if (
                        row.historical ||
                        e.button !== 0 ||
                        e.metaKey ||
                        e.ctrlKey ||
                        e.shiftKey ||
                        !(e.target as HTMLElement).closest('.source-number, .source-change-marker')
                      )
                        return;
                      e.preventDefault();
                      suppressClick.current = true;
                      drag.current = {
                        pointer: e.pointerId,
                        anchor: row.evidence,
                        range: row.evidence,
                        x: e.clientX,
                        y: e.clientY,
                        frame: 0,
                      };
                      setDragRange(row.evidence);
                      ref.current?.setPointerCapture(e.pointerId);
                      drag.current.frame = requestAnimationFrame(dragScroll);
                    }}
                    onMouseDown={(e) => {
                      if (e.shiftKey && !e.metaKey && !e.ctrlKey) e.preventDefault();
                    }}
                    title={
                      row.historical
                        ? 'Удалено после прошлого ревью. Нажмите, чтобы открыть прежний код.'
                        : undefined
                    }
                    onClick={(e) =>
                      row.historical
                        ? onHistoricalSource?.(row.evidence)
                        : select(row.evidence, e.shiftKey)
                    }
                  >
                    <span className="source-number">{row.left}</span>
                    <span className="source-number">{row.right}</span>
                    <code>
                      <span className="source-change-marker" aria-hidden="true">
                        {row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ' '}
                      </span>
                      <CodeTokens
                        tokens={tokens}
                        links={row.native ? links[number - 1] : []}
                        onDefinition={onDefinition}
                      />
                      {tokens.length === 0 ? row.text || ' ' : null}
                    </code>
                  </div>
                  <CodeComments
                    comments={threads}
                    onDelete={row.historical ? undefined : onDeleteComment}
                    deletableIds={
                      comparison ? new Set(comments.map((comment) => comment.id)) : undefined
                    }
                  />
                  {rowDiscussions(row).map((thread) => (
                    <DiscussionThread
                      key={`${thread.root.repoId}:${thread.root.id}`}
                      thread={thread}
                      sessionId={discussionSessionId}
                      onReply={onDiscussionReply}
                      onReact={onDiscussionReaction}
                    />
                  ))}
                  {!row.historical &&
                    selection &&
                    row.evidence.side === selection.side &&
                    row.evidence.path === selection.path &&
                    number === selection.endLine &&
                    commentEditor && (
                      <div
                        className="source-inline-comment"
                        ref={editor}
                        role="region"
                        aria-label="Комментарий к выделенному фрагменту"
                      >
                        {commentEditor}
                      </div>
                    )}
                </>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}
export function ContractViewer({ contract }: { contract: Contract }) {
  const [side, setSide] = useState<'before' | 'after'>('after');
  const spec = contract[side];
  // Prevent Swagger from fetching external refs or making API calls from an untrusted spec.
  const safeSpec = spec
    ? JSON.parse(JSON.stringify(spec), (key, value) =>
        key === '$ref' && typeof value === 'string' && !value.startsWith('#')
          ? '#/x-external-reference-disabled'
          : value,
      )
    : null;
  return (
    <section className="panel swagger-panel">
      <div className="segmented">
        <button className={side === 'before' ? 'active' : ''} onClick={() => setSide('before')}>
          До изменения
        </button>
        <button className={side === 'after' ? 'active' : ''} onClick={() => setSide('after')}>
          После изменения
        </button>
      </div>
      {safeSpec ? (
        <Suspense fallback={<p>Открываем спецификацию…</p>}>
          <Swagger
            spec={safeSpec}
            supportedSubmitMethods={[]}
            validatorUrl={null}
            docExpansion="list"
            defaultModelsExpandDepth={-1}
            requestInterceptor={(request) => {
              throw new Error(
                `Сетевые обращения Swagger отключены: ${request.method ?? 'request'}`,
              );
            }}
          />
        </Suspense>
      ) : (
        <Empty title="Спецификация отсутствует в этой версии" />
      )}
    </section>
  );
}
export function Setup({
  repos,
  onClose,
  onCreated,
  onRepo,
  onError,
}: {
  repos: Repository[];
  onClose: () => void;
  onCreated: (s: ReviewSession) => Promise<void>;
  onRepo: (r: Repository) => void;
  onError: (s: string) => void;
}) {
  const [path, setPath] = useState(''),
    [title, setTitle] = useState(''),
    [selection, setSelection] = useState<Record<string, number | null | undefined>>({}),
    [prs, setPrs] = useState<Record<string, PullRequest[]>>({}),
    [loading, setLoading] = useState(''),
    [error, setError] = useState('');
  async function work(label: string, fn: () => Promise<void>) {
    setLoading(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  }
  async function pulls(repo: Repository) {
    await work('Загружаем PR', async () => {
      const rows = await api<PullRequest[]>(`/repositories/${repo.id}/pulls`);
      setPrs((p) => ({ ...p, [repo.id]: rows }));
    });
  }
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Новая сессия ревью"
        className="modal setup-modal"
      >
        <div className="section-heading">
          <div>
            <div className="eyebrow">НОВАЯ СЕССИЯ</div>
            <h2>Подключите контекст ревью</h2>
          </div>
          <button disabled={!!loading} onClick={onClose}>
            ×
          </button>
        </div>
        <p>
          Выберите локальные репозитории и по одному PR для каждого. Другие сервисы можно подключить
          как контекст на текущем HEAD.
        </p>
        <label className="field-label" htmlFor="session-title">
          Название ревью
        </label>
        <input
          id="session-title"
          placeholder="Например: создание заказа и оплата"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="field-label" htmlFor="repo-path">
          Каталог Git-репозитория
        </label>
        <div className="input-row repo-connect-row">
          <input
            id="repo-path"
            placeholder="/Users/you/projects/order-service"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={!!loading}
          />
          <button
            disabled={!!loading}
            onClick={() =>
              void work('Выберите папку в системном окне', async () => {
                const selected = await api<{ path: string | null }>(
                  '/repositories/pick-directory',
                  'POST',
                  {},
                );
                if (selected.path !== null) setPath(selected.path);
              })
            }
          >
            Выбрать папку…
          </button>
          <button
            disabled={!path.trim() || !!loading}
            onClick={() =>
              void work('Подключаем', async () => {
                const repo = await api<Repository>('/repositories', 'POST', { path: path.trim() });
                onRepo(repo);
                setPath('');
              })
            }
          >
            Подключить
          </button>
        </div>
        <div className="repo-picker">
          {repos.map((r) => (
            <div className="repo-choice" key={r.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selection[r.id] !== undefined}
                  onChange={(e) => {
                    setSelection((s) => ({ ...s, [r.id]: e.target.checked ? null : undefined }));
                    if (e.target.checked && !prs[r.id]) void pulls(r);
                  }}
                />
                <span>
                  <strong>{r.name}</strong>
                  <small>{r.path}</small>
                </span>
              </label>
              {selection[r.id] !== undefined && (
                <div className="repo-pr">
                  <select
                    aria-label={`PR ${r.name}`}
                    value={selection[r.id] ?? 'context'}
                    onChange={(e) =>
                      setSelection((s) => ({
                        ...s,
                        [r.id]: e.target.value === 'context' ? null : Number(e.target.value),
                      }))
                    }
                  >
                    <option value="context">Только контекст · локальный HEAD</option>
                    {prs[r.id]?.map((p) => (
                      <option value={p.number} key={p.number}>
                        #{p.number} · {p.title}
                      </option>
                    ))}
                  </select>
                  <button disabled={!!loading} onClick={() => void pulls(r)}>
                    ↻
                  </button>
                  <div className="input-row manual-pr">
                    <label>Номер PR</label>
                    <input
                      type="number"
                      min={1}
                      placeholder="или введите номер"
                      value={selection[r.id] ?? ''}
                      onChange={(e) =>
                        setSelection((s) => ({
                          ...s,
                          [r.id]: e.target.value ? Number(e.target.value) : null,
                        }))
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}
        <div className="draft-footer">
          <small>{loading || 'Код PR будет прочитан без запуска сборок и скриптов.'}</small>
          <button
            className="primary"
            disabled={!!loading || !Object.values(selection).some((v) => typeof v === 'number')}
            onClick={() =>
              void work('Фиксируем снимки Git…', async () => {
                const repositories = Object.entries(selection)
                  .filter(([, pr]) => pr !== undefined)
                  .map(([repoId, prNumber]) => ({ repoId, prNumber }));
                const s = await api<ReviewSession>('/sessions', 'POST', {
                  title: title.trim() || 'Новое ревью',
                  repositories,
                });
                try {
                  await onCreated(s);
                } catch (e) {
                  onError(String(e));
                }
              })
            }
          >
            Создать ревью ↗
          </button>
        </div>
      </section>
    </div>
  );
}

export function SqlQueryDrawer({
  sessionId,
  evidence,
  snapshotId,
  onClose,
  onCode,
  analysisKey,
  analyzing,
  canGenerate,
  onGenerate,
}: {
  sessionId: string;
  evidence: Evidence;
  snapshotId: string;
  onClose: () => void;
  onCode: () => void;
  analysisKey: string;
  analyzing: boolean;
  canGenerate: boolean;
  onGenerate: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<SqlPreview | null>(null),
    [error, setError] = useState(''),
    [variantIndex, setVariantIndex] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setVariantIndex(0);
    setError('');
    const query = new URLSearchParams({
      repoId: evidence.repoId,
      path: evidence.path,
      side: evidence.side,
      line: String(evidence.startLine),
      snapshotId,
    });
    void api<SqlPreview>(`/sessions/${sessionId}/sql-preview?${query}`)
      .then((data) => {
        if (active) setPreview(data);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => {
      active = false;
      window.removeEventListener('keydown', escape);
    };
  }, [
    sessionId,
    evidence.repoId,
    evidence.path,
    evidence.side,
    evidence.startLine,
    snapshotId,
    analysisKey,
  ]);
  const variants = preview?.variants ?? [];
  const activeVariant = variants[variantIndex] ?? variants[0];
  const sql = activeVariant?.sql ?? preview?.sql ?? '';
  const parameters = activeVariant?.parameters ?? preview?.parameters ?? [];
  const shapesDiffer =
    new Set(variants.map((variant) => variant.sql.replace(/\s+/g, ' ').trim())).size > 1;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="sql-preview-title"
        className="source-drawer sql-preview-drawer"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">
              SQL · {evidence.side === 'head' ? 'ПОСЛЕ ИЗМЕНЕНИЯ' : 'ДО ИЗМЕНЕНИЯ'}
            </span>
            <h3 id="sql-preview-title">{evidence.path}</h3>
          </div>
          <button ref={closeButton} aria-label="Закрыть SQL" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="sql-drawer-content">
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          {!preview && !error && <p role="status">Подготавливаем SQL…</p>}
          {preview && (
            <>
              <p>
                <strong>{preview.method}()</strong> · {preview.dialect} ·{' '}
                <code>{preview.headSha.slice(0, 7)}</code>
              </p>
              <p className="sql-origin">
                {preview.origin === 'captured'
                  ? 'SQL из предоставленной трассировки приложения'
                  : preview.origin === 'source'
                    ? 'Нативный SQL из исходника'
                    : preview.origin === 'reconstructed'
                      ? 'SQL-шаблон, восстановленный по DSL · не runtime-трассировка'
                      : preview.origin === 'model'
                        ? 'SQL восстановлен Codex во время анализа · не runtime-трассировка'
                        : 'SQL для этого пути пока не получен'}
                {preview.renderer && <small>{preview.renderer}</small>}
              </p>
              {sql && <CodeBlock text={sql} language="sql" />}
              {(parameters.length > 0 || variants.length > 1) && (
                <details open>
                  <summary>
                    Bind-параметры ·{' '}
                    {variants.length > 1 ? `${variants.length} варианта` : parameters.length}
                  </summary>
                  {variants.length > 1 && (
                    <label className="sql-parameter-variants">
                      Вариант
                      <select
                        value={variantIndex}
                        onChange={(event) => setVariantIndex(Number(event.target.value))}
                      >
                        {variants.map((variant, index) => (
                          <option key={index} value={index}>
                            {variant.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {shapesDiffer && (
                    <p className="sql-variant-note">
                      Набор полей или условия SQL зависят от выбранного варианта.
                    </p>
                  )}
                  <ol>
                    {parameters.map((parameter) => (
                      <li key={parameter.position}>
                        <code>?{parameter.position}</code> ← <code>{parameter.expression}</code>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {!sql && (
                <div className="sql-unavailable" role="status">
                  <strong>Почему SQL не сформирован</strong>
                  <ul>
                    {(activeVariant?.unknowns ?? preview.unknowns).map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                  <p>
                    Исходная DSL-цепочка доступна по ссылке ниже. Codex формирует SQL при анализе
                    кода.
                  </p>
                </div>
              )}
              {canGenerate && (
                <button
                  disabled={analyzing}
                  onClick={() => {
                    setError('');
                    void onGenerate().catch((error) => setError(error.message));
                  }}
                >
                  {analyzing ? 'Codex формирует SQL…' : 'Дополнить SQL через Codex'}
                </button>
              )}
              <button className="text-button" onClick={onCode}>
                Открыть код запроса →
              </button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
