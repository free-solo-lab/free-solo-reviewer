import { stepDescription } from '../shared/step-description';
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
import {
  sequenceActivations,
  sequenceEntry,
  sequenceReturns,
  type SequenceActivation,
} from '../shared/sequence-activations';
import type { SqlPreview } from '../shared/sql-preview';
import { sequenceLayout, type TransactionRegion } from '../shared/transactions';
import { api } from './api';
import { GitHubAccountPicker } from './GitHubAccountPicker';
import { LocalBasePicker } from './LocalBasePicker';
import { chooseRepositoryDirectory } from './platform';
import { CodeTokens, CodeBlock } from './Code';
import { SequenceCanvas } from './SequenceCanvas';
import { highlightLines, highlightDiff, languageForPath } from './syntax';
import { useEditableCode, type InlineEditing } from './workspace/useEditableCode';
import { visibleText } from './workspace/editable-code';
import { codeLineChunks } from '../shared/code-edits';
import { sourceChangeBlocks, nextSourceChange } from '../shared/source-changes';
import { scopedSourceRows } from '../shared/scenario-code';
import { errorMessage } from '../shared/errors';
import { Icon, IconButton } from './icons';
import { Dialog, DialogClose, DialogTitle } from './ui/Dialog';
import { t } from '../shared/i18n';
// Swagger and its 180 KB stylesheet load only when a contract is opened.
const Swagger = lazy(() =>
  Promise.all([import('swagger-ui-react'), import('swagger-ui-react/swagger-ui.css')]).then(
    ([m]) => ({
      default: m.default as React.ComponentType<
        React.ComponentProps<typeof m.default> & { validatorUrl: null }
      >,
    }),
  ),
);
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
        {t('△ Unknowns and limitations')} <span>{gaps.length}</span>
      </summary>
      <ul>
        {gaps.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    </details>
  ) : null;
}
/** Whether GitHub can attach the comment to a changed line; otherwise it goes to the review body. */
export function isInlineComment(snapshot: Snapshot, e: Evidence) {
  const f = snapshot.files.find(
    (f) => (e.side === 'head' ? f.path : (f.oldPath ?? f.path)) === e.path,
  );
  return (
    e.repoId === snapshot.repoId &&
    !!f &&
    (e.side === 'head' ? f.addedLines : f.removedLines).includes(e.startLine)
  );
}
export function commentLocation(snapshot: Snapshot, e: Evidence | null) {
  if (!e) return t('In the review summary');
  return isInlineComment(snapshot, e)
    ? `Inline · ${e.path}:${e.startLine} · ${e.side === 'head' ? 'RIGHT' : 'LEFT'}`
    : t('In the review summary · {0}:{1} ({2})', e.path, e.startLine, e.side);
}
/** Width of the activation bar on a lifeline. */
const BAR = 10;
/** Distance from a step's arrow to the answer that closes its bar, below the result models. */
const ANSWER = 52;
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
  const first = scenario.steps[0];
  // The entry call gets a row of its own above the first step.
  const top = participantLayout?.hasClasses ? 220 : participants ? 166 : 126;
  const entryY = top - 20;
  const activations = sequenceActivations(scenario.steps);
  const answers = sequenceReturns(activations);
  const gaps: number[] = scenario.steps.map((s) => (stepDescription(s) ? 20 : 0));
  for (const answer of answers)
    gaps[answer.end] = Math.max(gaps[answer.end] ?? 0, answer.rank * 18);
  const layout = sequenceLayout(scenario, transactions, top + (first ? 56 : 0), gaps);
  // Answers come below the result models of their last step, the inner one first.
  const answerY = (end: number, rank: number) =>
    layout.rows[end] + ANSWER + (stepDescription(scenario.steps[end]) ? 20 : 0) + rank * 18;
  const barBottom = (bar: SequenceActivation) => {
    const answer = answers.find(
      (item) => item.lane === bar.lane && item.start === bar.start && item.depth === bar.depth,
    );
    return answer ? answerY(answer.end, answer.rank) : layout.rows[bar.end] + ANSWER - 12;
  };
  const entry = first
    ? sequenceEntry(
        scenario.steps,
        indexes,
        participants?.find((p) => p.id === first.from && p.kind === 'class')?.evidence,
      )
    : null;
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
                  ? t('{0} service {1}', isCollapsed ? t('Expand') : t('Collapse'), name(id))
                  : classSource
                    ? t('Open the whole code of class {0}', name(id))
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
                  ? t('{0} · click to change the level of detail', name(id))
                  : classSource
                    ? t('{0} · open the whole class code', name(id))
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
            <marker
              id="answer"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
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
                ? t('NO TX')
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
                  aria-label={t('Transaction boundary: {0} · {1}', frame.title, frame.propagation)}
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
          {activations.map((bar) => (
            <rect
              key={`${bar.lane}:${bar.start}:${bar.depth}`}
              className="sequence-activation"
              x={x(bar.lane) - BAR / 2 + bar.depth * BAR * 0.6}
              y={bar.start < 0 ? entryY : layout.rows[bar.start]}
              width={BAR}
              height={barBottom(bar) - (bar.start < 0 ? entryY : layout.rows[bar.start])}
            />
          ))}
          {answers.map((answer) => {
            const y = answerY(answer.end, answer.rank);
            const from =
                x(answer.lane) -
                Math.sign(x(answer.lane) - (answer.caller ? x(answer.caller) : 18)) * (BAR / 2),
              to = answer.caller
                ? x(answer.caller) + Math.sign(x(answer.lane) - x(answer.caller)) * (BAR / 2)
                : 18;
            const call = answer.start >= 0 ? scenario.steps[answer.start] : undefined;
            const outputs = call ? sequenceMethod(call, indexes, snapshots).outputs : [];
            return (
              <g key={`answer:${answer.lane}:${answer.start}`} className="sequence-return">
                <line x1={from} x2={to} y1={y} y2={y} markerEnd="url(#answer)" />
                {outputs.length > 0 && (
                  <text x={(from + to) / 2} y={y - 5} textAnchor="middle">
                    {outputs.map((model) => model.name).join(', ')}
                  </text>
                )}
                <title>
                  {answer.caller
                    ? t('Return {0} → {1}', name(answer.lane), name(answer.caller))
                    : t('Scenario exit')}
                </title>
              </g>
            );
          })}
          {first && (
            <g
              className={`sequence-entry ${entry ? '' : 'unknown'}`}
              role={entry ? 'button' : undefined}
              tabIndex={entry ? 0 : undefined}
              aria-label={entry ? t('Open entry method {0}', entry.name) : undefined}
              onClick={entry ? () => onSelect([entry.evidence]) : undefined}
              onKeyDown={
                entry
                  ? (e) => {
                      if (e.key === 'Enter') onSelect([entry.evidence]);
                    }
                  : undefined
              }
            >
              <circle cx={18} cy={entryY} r={4} />
              <line
                x1={18}
                x2={x(first.from) - BAR / 2}
                y1={entryY}
                y2={entryY}
                markerEnd="url(#arrow)"
              />
              <text x={24} y={entryY - 10}>
                {entry ? `${entry.name}()` : t('Scenario start')}
              </text>
              <title>
                {entry
                  ? t('Entry method {0}.{1}() · open code', name(first.from), entry.name)
                  : t('The method that starts the scenario was not found in the code')}
              </title>
            </g>
          )}
          {scenario.steps.map((s, i) => {
            const y = layout.rows[i];
            const self = s.from === s.to;
            // Arrows start and end at the edges of the activation bars, not at the dashed line.
            const side = Math.sign(x(s.to) - x(s.from)) * (BAR / 2);
            const method = sequenceMethod(s, indexes, snapshots);
            const purpose = stepDescription(s);
            const captionOffset = purpose ? 20 : 0;
            const captionLimit = Math.max(
              24,
              Math.min(88, Math.floor((Math.abs(x(s.to) - x(s.from)) || 220) / 6) - 4),
            );
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
              ? t(
                  '{0} · open query',
                  s.label.match(/\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i)?.[1]?.toUpperCase() ??
                    'SQL',
                )
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
                aria-label={sql ? t('Open SQL: {0}', s.label) : t('Open call: {0}', s.label)}
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
                  <line
                    x1={x(s.from) + side}
                    x2={x(s.to) - side}
                    y1={y}
                    y2={y}
                    markerEnd="url(#arrow)"
                  />
                )}
                <title>{purpose ? `${label} — ${purpose}` : label}</title>
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
                {purpose && (
                  <text
                    className="sequence-purpose"
                    x={self ? x(s.from) + 12 : (x(s.from) + x(s.to)) / 2}
                    y={y + (self ? 36 : 20)}
                    textAnchor={self ? 'start' : 'middle'}
                  >
                    <title>{purpose}</title>
                    {purpose.length > captionLimit
                      ? `${purpose.slice(0, captionLimit - 1)}…`
                      : purpose}
                  </text>
                )}
                {!sql && (method.inputs.length > 0 || method.outputs.length > 0) && (
                  <text
                    className="sequence-models"
                    x={self ? x(s.from) + 12 : (x(s.from) + x(s.to)) / 2}
                    y={y + (self ? 38 : 22) + captionOffset}
                    textAnchor={self ? 'start' : 'middle'}
                  >
                    {[
                      { label: t('Input'), models: method.inputs },
                      { label: t('Exit'), models: method.outputs },
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
                                  <title>
                                    {t('Open model:')} {model.evidence.path}
                                  </title>
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
    <div className="code-comment-thread" role="region" aria-label={t('Code comments')}>
      {comments.map((comment) => (
        <article className="code-comment-card" key={comment.id}>
          <div className="code-comment-heading">
            <strong>{comment.forCodex ? t('Task for Codex') : t('Your comment')}</strong>
            <span>
              {comment.evidence?.startLine === comment.evidence?.endLine
                ? t('Line {0}', comment.evidence?.startLine)
                : t('Lines {0}–{1}', comment.evidence?.startLine, comment.evidence?.endLine)}
            </span>
            {comment.forCodex ? (
              <small className="codex-comment-tag">{t('For Codex')}</small>
            ) : (
              !comment.selected && <small>{t('Not included in the submission')}</small>
            )}
            {onDelete && (!deletableIds || deletableIds.has(comment.id)) && (
              <IconButton
                icon="trash"
                label={t('Delete comment')}
                className="code-comment-delete"
                onClick={() => onDelete(comment.id)}
              />
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
  inlineEditing,
  toolbarActions,
  changeNavigation = true,
  ranges,
  autoScroll = true,
  deletableCommentIds,
}: {
  deletableCommentIds?: Set<string>;
  ranges?: Evidence[];
  autoScroll?: boolean;
  toolbarActions?: React.ReactNode;
  /** The bar of previous/next change; a scenario's code flow goes without it. */
  changeNavigation?: boolean;
  /** The current lines are one editor over the diff; removed lines stay read-only. */
  inlineEditing?: InlineEditing;
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
  const expandedTarget = useRef('');
  useEffect(() => {
    if (!autoScroll || evidence.startLine <= 1) return;
    const target = methods.find(
      (entry) =>
        entry.method.evidence.startLine <= evidence.startLine &&
        entry.method.evidence.endLine >= evidence.startLine,
    );
    if (!target) return;
    const key = `${visitId}:${evidence.repoId}:${evidence.path}:${target.key}`;
    if (expandedTarget.current === key) return;
    expandedTarget.current = key;
    setExpandedMethods((previous) => new Set(previous).add(target.key));
  }, [visitId, evidence.repoId, evidence.path, evidence.startLine, methods, autoScroll]);
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
  const fullRows = useMemo(
    () =>
      !text && inlineEditing
        ? [
            {
              text: '',
              kind: 'context' as const,
              left: 1,
              right: 1,
              native: true,
              evidence: { ...evidence, startLine: 1, endLine: 1 },
            },
          ]
        : comparison
          ? reviewDiffRows(text, evidence, comparison.file, comparison.previousPath)
          : sourceDiffRows(text, evidence, changedFile),
    [text, evidence.repoId, evidence.side, evidence.path, changedFile, comparison, !!inlineEditing],
  );
  const rows = useMemo(() => scopedSourceRows(fullRows, ranges), [fullRows, ranges]);
  const originalChunks = useMemo(() => codeLineChunks(text), [text]);
  const generation = useEditableCode(ref, inlineEditing);
  const methodRows = useMemo(() => sourceMethodRows(rows, methods), [rows, methods]);
  /** Added and removed lines of each method, shown on its header like GitHub's file stats. */
  const methodStats = useMemo(() => {
    const stats = new Map<string, { added: number; removed: number }>();
    for (const { row, method } of methodRows) {
      if (!method || row.kind === 'context') continue;
      const entry = stats.get(method.key) ?? { added: 0, removed: 0 };
      if (row.kind === 'addition') entry.added++;
      else entry.removed++;
      stats.set(method.key, entry);
    }
    return stats;
  }, [methodRows]);
  const changeBlocks = useMemo(
    () =>
      sourceChangeBlocks(
        rows,
        new Set(
          inlineEditing?.chunks.flatMap((value, i) =>
            value !== originalChunks[i] ? [i + 1] : [],
          ) ?? [],
        ),
      ),
    [rows, inlineEditing?.chunks, originalChunks],
  );
  const [changeJump, setChangeJump] = useState({ row: -1, serial: 0 });
  useEffect(
    () => setChangeJump({ row: -1, serial: 0 }),
    [visitId, evidence.repoId, evidence.path, evidence.side, comparison, changedFile],
  );
  const activeChange = changeBlocks.findIndex(
    (block) => changeJump.row >= block.start && changeJump.row <= block.end,
  );
  const jumpToChange = (direction: -1 | 1) => {
    const index = nextSourceChange(activeChange, direction, changeBlocks.length);
    if (index < 0) return;
    const block = changeBlocks[index];
    setExpandedMethods((previous) => {
      const next = new Set(previous);
      for (let i = block.start; i <= block.end; i++) {
        const method = methodRows[i]?.method;
        if (method) next.add(method.key);
      }
      return next;
    });
    setChangeJump((previous) => ({ row: block.start, serial: previous.serial + 1 }));
  };
  useEffect(() => {
    if (changeJump.row < 0 || !changeJump.serial) return;
    const frame = requestAnimationFrame(() => {
      ref.current
        ?.querySelector(`[data-change-row="${changeJump.row}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [changeJump]);
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
  const unplacedThreads = ranges
    ? []
    : [
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
    if (!autoScroll) return;
    ref.current
      ?.querySelector(
        `[data-source-side="${evidence.side}"][data-source-line="${evidence.startLine}"]`,
      )
      ?.scrollIntoView({ block: 'center' });
    if (position && ref.current) {
      ref.current.scrollTop = position.top;
      ref.current.scrollLeft = position.left;
    }
  }, [evidence.repoId, evidence.side, evidence.path, visitId, autoScroll]);
  return (
    <>
      {changeNavigation && (
        <div className="code-toolbar">
          <div className="source-change-navigation" role="group" aria-label={t('Navigate changes')}>
            <IconButton
              icon="arrowLeft"
              label={t('Previous change')}
              title={t('Previous change · ⌘←')}
              tooltip={false}
              disabled={!changeBlocks.length}
              onClick={() => jumpToChange(-1)}
            />
            <span aria-live="polite">
              {activeChange >= 0
                ? `${activeChange + 1}/${changeBlocks.length}`
                : t('{0} chg.', changeBlocks.length)}
            </span>
            <IconButton
              icon="arrowRight"
              label={t('Next change')}
              title={t('Next change · ⌘→')}
              tooltip={false}
              disabled={!changeBlocks.length}
              onClick={() => jumpToChange(1)}
            />
          </div>
          {methodError && <span role="alert">{methodError}</span>}
          {toolbarActions && <div className="source-toolbar-actions">{toolbarActions}</div>}
        </div>
      )}
      {!changeNavigation && methodError && (
        <p className="code-toolbar" role="alert">
          {methodError}
        </p>
      )}
      <div
        className={`source-code syntax-light ${dragRange ? 'source-dragging' : ''} ${inlineEditing ? 'source-editable' : ''}`}
        contentEditable={inlineEditing ? true : undefined}
        suppressContentEditableWarning
        spellCheck={inlineEditing ? false : undefined}
        autoCorrect={inlineEditing ? 'off' : undefined}
        autoCapitalize={inlineEditing ? 'off' : undefined}
        role={inlineEditing ? 'textbox' : undefined}
        aria-multiline={inlineEditing ? true : undefined}
        aria-label={inlineEditing ? t('Editing {0}', evidence.path) : undefined}
        onClick={(event) => {
          // ⌘-click on a call opens its definition, as in the read-only view.
          if (!inlineEditing || !(event.metaKey || event.ctrlKey)) return;
          const span = (event.target as HTMLElement).closest<HTMLElement>('[data-edit-line]');
          const selection = window.getSelection();
          if (!span || !selection?.anchorNode) return;
          const line = Number(span.dataset.editLine);
          if (inlineEditing.chunks[line - 1] !== originalChunks[line - 1]) return;
          const range = document.createRange();
          range.selectNodeContents(span);
          range.setEnd(selection.anchorNode, selection.anchorOffset);
          const at = range.toString().length;
          const link = links[line - 1]?.find((item) => at >= item.start && at <= item.end);
          if (link) onDefinition?.(link);
        }}
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
          // Only the click that ends this drag is swallowed. Under pointer capture there may be
          // none, and a flag left on would eat the next click, e.g. folding a method.
          window.setTimeout(() => (suppressClick.current = false));
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
          <details
            className="source-outdated-discussions"
            open
            contentEditable={inlineEditing ? false : undefined}
          >
            <summary>
              {t('Discussions of the previous version or the other side of the diff')}
            </summary>
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
            autoScroll &&
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
          const editable =
            !!inlineEditing && row.native && !row.historical && row.evidence.side === 'head';
          const chunk = editable ? (inlineEditing!.chunks[number - 1] ?? '') : '';
          // A line whose text moved into the previous one while editing; its anchors stay.
          const joined = editable && !chunk && number > 1;
          const Annotations = inlineEditing ? NonEditable : React.Fragment;
          return (
            <React.Fragment key={i}>
              {methodStart && methodEntry && (
                <div
                  contentEditable={inlineEditing ? false : undefined}
                  className={`source-method-toolbar ${methodEntry.viewed ? 'viewed' : ''}`}
                  data-source-side={folded ? evidence.side : undefined}
                  data-source-line={folded ? number : undefined}
                >
                  <button
                    className="source-method-name"
                    aria-expanded={!folded}
                    onClick={() => toggleMethod(methodEntry)}
                    title={methodEntry.method.signature}
                  >
                    <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={14} />
                    <code>{methodEntry.method.name}()</code>
                    {folded && (
                      <span>
                        {methodEntry.method.evidence.endLine - number + 1} {t('lines')}
                      </span>
                    )}
                  </button>
                  <DiffStat {...(methodStats.get(methodEntry.key) ?? { added: 0, removed: 0 })} />
                  <label className="source-method-viewed">
                    <input
                      type="checkbox"
                      aria-label={t('{0}: viewed', methodEntry.method.name)}
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
                    />
                    {t('Viewed')}
                  </label>
                  {folded && methodsWithComments.has(methodEntry.key) && (
                    <button className="text-button" onClick={() => toggleMethod(methodEntry)}>
                      {t('Show comments')}
                    </button>
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
                    data-change-row={i}
                    contentEditable={inlineEditing && !editable ? false : undefined}
                    className={`source-line ${row.kind} ${joined ? 'source-line-joined' : ''} ${navigationTarget ? 'source-navigation-target' : ''} ${selected ? 'source-selected' : ''} ${changeBlocks[activeChange] && i >= changeBlocks[activeChange].start && i <= changeBlocks[activeChange].end ? 'source-current-change' : ''}`}
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
                      if ((e.target as HTMLElement).closest('textarea, [data-edit-line]')) return;
                      if (e.shiftKey && !e.metaKey && !e.ctrlKey) e.preventDefault();
                    }}
                    title={
                      row.historical
                        ? t('Removed since the last review. Click to open the previous code.')
                        : undefined
                    }
                    onClick={(e) => {
                      if (row.historical) return onHistoricalSource?.(row.evidence);
                      // While editing, a click in the code places the caret; numbers comment.
                      if (
                        inlineEditing &&
                        !(e.target as HTMLElement).closest('.source-number, .source-change-marker')
                      )
                        return;
                      select(row.evidence, e.shiftKey);
                    }}
                  >
                    <span
                      className="source-number"
                      contentEditable={inlineEditing ? false : undefined}
                    >
                      {row.left}
                    </span>
                    <span
                      className="source-number"
                      contentEditable={inlineEditing ? false : undefined}
                    >
                      {row.right}
                    </span>
                    <code>
                      <span
                        className="source-change-marker"
                        aria-hidden="true"
                        contentEditable={inlineEditing ? false : undefined}
                      >
                        {row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ' '}
                      </span>
                      {editable ? (
                        <EditText
                          key={`${generation}:${number}`}
                          value={chunk}
                          original={originalChunks[number - 1] ?? ''}
                          line={number}
                          path={evidence.path}
                        />
                      ) : (
                        <>
                          <CodeTokens
                            tokens={tokens}
                            links={row.native ? links[number - 1] : []}
                            onDefinition={onDefinition}
                          />
                          {tokens.length === 0 ? row.text || ' ' : null}
                        </>
                      )}
                    </code>
                  </div>
                  <Annotations>
                    <CodeComments
                      comments={threads}
                      onDelete={row.historical ? undefined : onDeleteComment}
                      deletableIds={
                        deletableCommentIds ??
                        (comparison ? new Set(comments.map((comment) => comment.id)) : undefined)
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
                          aria-label={t('Comment on the selected fragment')}
                        >
                          {commentEditor}
                        </div>
                      )}
                  </Annotations>
                </>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}
/** The OpenAPI specification as Swagger UI, before or after the change; it never calls the API. */
export function SwaggerView({ contract }: { contract: Contract }) {
  const [side, setSide] = useState<'before' | 'after'>(contract.after ? 'after' : 'before');
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
    <section className="swagger-panel">
      <div className="segmented">
        <button className={side === 'before' ? 'active' : ''} onClick={() => setSide('before')}>
          {t('Before the change')}
        </button>
        <button className={side === 'after' ? 'active' : ''} onClick={() => setSide('after')}>
          {t('After the change')}
        </button>
      </div>
      {safeSpec ? (
        <Suspense fallback={<p>{t('Opening the specification…')}</p>}>
          <Swagger
            spec={safeSpec}
            supportedSubmitMethods={[]}
            validatorUrl={null}
            docExpansion="list"
            defaultModelsExpandDepth={-1}
            requestInterceptor={(request) => {
              throw new Error(
                t('Swagger network requests are disabled: {0}', request.method ?? 'request'),
              );
            }}
          />
        </Suspense>
      ) : (
        <Empty title={t('The specification is missing in this version')} />
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
  const [mode, setMode] = useState<'pr' | 'local'>('pr');
  const [baseRefs, setBaseRefs] = useState<Record<string, string>>({});
  async function work(label: string, fn: () => Promise<void>) {
    setLoading(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading('');
    }
  }
  async function pulls(repo: Repository) {
    if (repo.slug.startsWith('local/')) return;
    await work(t('Loading PRs'), async () => {
      const rows = await api<PullRequest[]>(`/repositories/${repo.id}/pulls`);
      setPrs((p) => ({ ...p, [repo.id]: rows }));
    });
  }
  return (
    <Dialog
      className="modal setup-modal"
      dismissible={!loading}
      closeOnOutsideClick={false}
      onClose={onClose}
    >
      <div className="section-heading">
        <div>
          <div className="eyebrow">{t('NEW SESSION')}</div>
          <DialogTitle>{t('Connect the review context')}</DialogTitle>
        </div>
        <DialogClose asChild>
          <IconButton icon="close" label={t('Close')} tooltip={false} disabled={!!loading} />
        </DialogClose>
      </div>
      <div className="review-mode-switch" role="group" aria-label={t('Review mode')}>
        <button
          className={mode === 'pr' ? 'active' : ''}
          disabled={!!loading}
          onClick={() => {
            setMode('pr');
            setSelection({});
            setError('');
          }}
        >
          GitHub PR
        </button>
        <button
          className={mode === 'local' ? 'active' : ''}
          disabled={!!loading}
          onClick={() => {
            setMode('local');
            setSelection({});
            setError('');
          }}
        >
          {t('Before PR · local changes')}
        </button>
      </div>
      <p>
        {mode === 'pr'
          ? t(
              'Choose repositories and PRs. Other services can be connected as context at their current HEAD.',
            )
          : t(
              'Review of the working folder: branch commits, staged and unstaged changes, new files. By default the project’s main branch is the base; origin/main or origin/master is updated before comparing. HEAD means only changes since the last commit. No PR is needed.',
            )}
      </p>
      <label className="field-label" htmlFor="session-title">
        {t('Review title')}
      </label>
      <input
        id="session-title"
        placeholder={t('For example: order creation and payment')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="field-label" htmlFor="repo-path">
        {t('Git repository folder')}
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
            void work(t('Choose a folder in the system dialog'), async () => {
              const selected = await chooseRepositoryDirectory();
              if (selected !== null) setPath(selected);
            })
          }
        >
          {t('Choose folder…')}
        </button>
        <button
          disabled={!path.trim() || !!loading}
          onClick={() =>
            void work(t('Connecting'), async () => {
              const repo = await api<Repository>('/repositories', 'POST', { path: path.trim() });
              onRepo(repo);
              setPath('');
            })
          }
        >
          {t('Connect')}
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
                  if (
                    mode === 'pr' &&
                    e.target.checked &&
                    !prs[r.id] &&
                    !r.slug.startsWith('local/')
                  )
                    void pulls(r);
                }}
              />
              <span>
                <strong>{r.name}</strong>
                <small>{r.path}</small>
              </span>
            </label>
            <GitHubAccountPicker
              repo={r}
              disabled={!!loading}
              onChange={(updated) => {
                onRepo(updated);
                if (mode === 'pr' && selection[updated.id] !== undefined) void pulls(updated);
              }}
            />
            {selection[r.id] !== undefined && mode === 'local' && (
              <LocalBasePicker
                repo={r}
                value={baseRefs[r.id] ?? r.defaultLocalBase ?? 'HEAD'}
                disabled={!!loading}
                onChange={(value) => setBaseRefs((values) => ({ ...values, [r.id]: value }))}
              />
            )}
            {selection[r.id] !== undefined && mode === 'pr' && r.slug.startsWith('local/') && (
              <p>
                {t(
                  'Context only · local HEAD. To review changes, choose the “Before PR · local changes” mode.',
                )}
              </p>
            )}
            {selection[r.id] !== undefined && mode === 'pr' && !r.slug.startsWith('local/') && (
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
                  <option value="context">{t('Context only · local HEAD')}</option>
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
                  <label>{t('PR number')}</label>
                  <input
                    type="number"
                    min={1}
                    placeholder={t('or enter a number')}
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
        <small>{loading || t('PR code is read without running builds or scripts.')}</small>
        <button
          className="primary"
          disabled={
            !!loading ||
            (mode === 'pr'
              ? !Object.values(selection).some((v) => typeof v === 'number')
              : !Object.values(selection).some((v) => v !== undefined))
          }
          onClick={() =>
            void work(t('Taking Git snapshots…'), async () => {
              const repositories = Object.entries(selection)
                .filter(([, pr]) => pr !== undefined)
                .map(([repoId, prNumber]) => ({
                  repoId,
                  prNumber: mode === 'local' ? null : prNumber,
                  ...(mode === 'local'
                    ? {
                        localBase: (
                          baseRefs[repoId] ??
                          repos.find((repo) => repo.id === repoId)?.defaultLocalBase ??
                          'HEAD'
                        ).trim(),
                      }
                    : {}),
                }));
              const s = await api<ReviewSession>('/sessions', 'POST', {
                title: title.trim() || t('New review'),
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
          {t('Create review ↗')}
        </button>
      </div>
    </Dialog>
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
  perMethod,
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
  /** SQL runs on request for this method only, so a method with SQL needs no button. */
  perMethod?: boolean;
  onGenerate: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<SqlPreview | null>(null),
    [error, setError] = useState(''),
    [variantIndex, setVariantIndex] = useState(0);
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
    return () => {
      active = false;
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
    <Dialog variant="drawer" className="source-drawer sql-preview-drawer" onClose={onClose}>
      <div className="drawer-heading">
        <div>
          <span className="eyebrow">
            SQL · {evidence.side === 'head' ? t('AFTER THE CHANGE') : t('BEFORE THE CHANGE')}
          </span>
          <DialogTitle asChild>
            <h3>{evidence.path}</h3>
          </DialogTitle>
        </div>
        <DialogClose asChild>
          <IconButton icon="close" label={t('Close SQL')} tooltip={false} />
        </DialogClose>
      </div>
      <div className="sql-drawer-content">
        {error && (
          <p className="alert error" role="alert">
            {error}
          </p>
        )}
        {!preview && !error && <p role="status">{t('Preparing SQL…')}</p>}
        {preview && (
          <>
            <p>
              <strong>{preview.method}()</strong> · {preview.dialect} ·{' '}
              <code>{preview.headSha.slice(0, 7)}</code>
            </p>
            <p className="sql-origin">
              {preview.origin === 'captured'
                ? t('SQL from the provided application trace')
                : preview.origin === 'source'
                  ? t('Native SQL from the source')
                  : preview.origin === 'reconstructed'
                    ? t('SQL template rebuilt from the DSL · not a runtime trace')
                    : preview.origin === 'model'
                      ? t('SQL rebuilt by Codex during the analysis · not a runtime trace')
                      : t('No SQL for this path yet')}
              {preview.renderer && <small>{preview.renderer}</small>}
            </p>
            {sql && <CodeBlock text={sql} language="sql" />}
            {(parameters.length > 0 || variants.length > 1) && (
              <details open>
                <summary>
                  {t('Bind parameters ·')}{' '}
                  {variants.length > 1 ? t('{0} variants', variants.length) : parameters.length}
                </summary>
                {variants.length > 1 && (
                  <label className="sql-parameter-variants">
                    {t('Variant')}
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
                    {t('The selected fields or SQL conditions depend on the chosen variant.')}
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
                <strong>{t('Why the SQL was not generated')}</strong>
                <ul>
                  {(activeVariant?.unknowns ?? preview.unknowns).map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
                <p>
                  {t(
                    'The source DSL chain is linked below. Codex generates SQL while analyzing the code.',
                  )}
                </p>
              </div>
            )}
            {canGenerate && (!perMethod || preview.origin === 'unavailable') && (
              <button
                disabled={analyzing}
                onClick={() => {
                  setError('');
                  void onGenerate().catch((error) => setError(error.message));
                }}
              >
                {analyzing
                  ? t('Codex is generating SQL…')
                  : perMethod
                    ? t('Generate SQL for this method')
                    : t('Complete SQL with Codex')}
              </button>
            )}
            <button className="text-button" onClick={onCode}>
              {t('Open query code →')}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** "+3 −3 ▪▪▪▪▫": the share of added and removed lines in five squares, as on GitHub. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  if (!total) return null;
  const green = Math.round((added / total) * Math.min(5, total));
  const red = Math.min(5, total) - green;
  return (
    <span className="diff-stat" title={t('Added {0}, removed {1}', added, removed)}>
      {added > 0 && <b className="added">+{added}</b>}
      {removed > 0 && <b className="removed">−{removed}</b>}
      <span aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <i key={i} className={i < green ? 'added' : i < green + red ? 'removed' : undefined} />
        ))}
      </span>
    </span>
  );
}

/** Comments and replies inside the editable code column keep their own fields. */
function NonEditable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="source-noedit" contentEditable={false}>
      {children}
    </div>
  );
}

/** One current line of the editable diff; it holds several lines once text is added to it. */
const EditText = React.memo(function EditText({
  value,
  original,
  line,
  path,
}: {
  value: string;
  original: string;
  line: number;
  path: string;
}) {
  const visible = visibleText(value);
  const lines = useMemo(() => highlightLines(visible, languageForPath(path)), [visible, path]);
  return (
    <span
      className={`source-edit-text ${value !== original ? 'modified' : ''}`}
      data-edit-line={line}
    >
      {lines.map((tokens, i) => (
        <React.Fragment key={i}>
          {i > 0 && '\n'}
          <CodeTokens tokens={tokens} />
        </React.Fragment>
      ))}
      {(!visible || visible.endsWith('\n')) && <br />}
    </span>
  );
});
