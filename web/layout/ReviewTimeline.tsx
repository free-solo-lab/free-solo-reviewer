import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReviewPoint } from '../../shared/review-timeline';
import { getLanguage, t } from '../../shared/i18n';
import { Icon } from '../icons';
import styles from './ReviewTimeline.module.css';

export function timelineSelection(
  points: Pick<ReviewPoint, 'id'>[],
  from: string,
  preview?: { key: string; index: number },
) {
  const key = JSON.stringify([from, points.map((p) => p.id)]);
  const selected = Math.max(
    0,
    points.findIndex((p) => p.id === from),
  );
  return {
    key,
    index: Math.max(
      0,
      Math.min(preview?.key === key ? preview.index : selected, Math.max(0, points.length - 2)),
    ),
  };
}

export function ReviewTimeline({
  points,
  from,
  disabled,
  onChange,
}: {
  points: ReviewPoint[];
  from: string;
  disabled?: boolean;
  onChange: (from: string) => Promise<void>;
}) {
  const last = points.length - 1;
  const selection = timelineSelection(points, from);
  const [draft, setDraft] = useState(selection);
  const current = timelineSelection(points, from, draft);
  const position = current.index,
    selected = selection.index;
  const pending = useRef(selection);
  const axis = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; from: number; pointerId: number }>();
  const sent = useRef(from);
  useEffect(() => {
    pending.current = selection;
    setDraft(selection);
    sent.current = from;
    drag.current = undefined;
  }, [selection.key]);
  const preview = (index: number) => {
    const next = {
      key: selection.key,
      index: Math.max(0, Math.min(Math.round(index), Math.max(0, last - 1))),
    };
    pending.current = next;
    setDraft(next);
  };
  const track = useRef<HTMLDivElement>(null);
  const nearest = (x: number) => {
    const box = axis.current?.getBoundingClientRect();
    return box?.width ? Math.round(((x - box.left) / box.width) * last) : selected;
  };
  const choose = (index: number) => {
    preview(index);
    void commit();
  };
  const commit = async () => {
    const target = timelineSelection(points, from, pending.current);
    const value = points[target.index]?.id;
    if (disabled || !value || value === sent.current) return;
    sent.current = value;
    try {
      await onChange(value);
    } catch {
      sent.current = from;
      preview(selected);
    }
  };
  const base = points[0]?.snapshots
    .filter((s) => s.local || s.pr)
    .map((s) => s.local?.baseRef ?? s.pr?.baseRefName)
    .filter(Boolean);
  const baseLabel = [...new Set(base)].join(' + ') || t('Initial base');
  const label = (i: number) =>
    i === 0
      ? baseLabel
      : i === last
        ? t('Current version')
        : points[i]?.kind === 'review'
          ? t('Review {0}', i)
          : t('Analysis {0}', i);
  // An approval of older code no longer covers what is reviewed now.
  const stale =
    points[last]?.decision !== 'APPROVE' &&
    points.slice(0, last).findLast((p) => p.decision && p.decision !== 'COMMENT')?.decision ===
      'APPROVE';
  const mark = (p: ReviewPoint, i: number) =>
    p.decision === 'APPROVE'
      ? { tone: 'approved', icon: 'check' as const, hint: t('You approved this version') }
      : p.decision === 'REQUEST_CHANGES'
        ? {
            tone: 'changes',
            icon: 'close' as const,
            hint: t('You requested changes on this version'),
          }
        : i === last && stale && !p.decision
          ? {
              tone: 'stale',
              icon: 'refresh' as const,
              hint: t('The code changed after your approval'),
            }
          : p.decision === 'COMMENT'
            ? {
                tone: 'comment',
                icon: 'message' as const,
                hint: t('You sent comments on this version'),
              }
            : undefined;
  const marks = points.map(mark);
  if (last < 1) return null;
  return (
    <div className={styles.scroll} aria-label={t('Comparison with the current version')}>
      <div
        className={styles.timeline}
        style={
          {
            '--points': points.length,
            '--start': `${(position / last) * 100}%`,
          } as CSSProperties
        }
      >
        <div className={styles.labels}>
          {points.map((p, i) => (
            <div key={p.id} data-selected={i === position || i === last}>
              {i === last ? (
                <strong title={marks[i]?.hint}>{label(i)}</strong>
              ) : (
                <button
                  disabled={disabled}
                  aria-pressed={i === position}
                  title={[
                    ...p.snapshots.map(
                      (s) => `${s.repoName}: ${(i ? s.headSha : s.mergeBase).slice(0, 10)}`,
                    ),
                    marks[i]?.hint,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  onClick={() => choose(i)}
                >
                  {label(i)}
                </button>
              )}
            </div>
          ))}
        </div>
        <div
          className={styles.axis}
          ref={axis}
          onClick={(e) => {
            // A click on the bare track picks the nearest earlier point.
            if (e.target === e.currentTarget || e.target === track.current)
              choose(nearest(e.clientX));
          }}
        >
          <div className={styles.track} ref={track} />
          <button
            className={styles.interval}
            disabled={disabled}
            aria-label={t(
              'Compare {0} with the current version. Drag to change the starting point.',
              label(position),
            )}
            onPointerDown={(e) => {
              if (e.button !== 0 || disabled) return;
              drag.current = { x: e.clientX, from: position, pointerId: e.pointerId };
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const width = axis.current?.getBoundingClientRect().width;
              if (d && width && d.pointerId === e.pointerId)
                preview(d.from + (e.clientX - d.x) / (width / last));
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              if (d?.pointerId !== e.pointerId) return;
              drag.current = undefined;
              e.currentTarget.releasePointerCapture(e.pointerId);
              // A click without dragging moves the start to the nearest point.
              if (Math.abs(e.clientX - d.x) < 4) preview(nearest(e.clientX));
              void commit();
            }}
            onPointerCancel={() => {
              drag.current = undefined;
              preview(selected);
            }}
            onKeyDown={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                preview(
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? last - 1
                      : position + (e.key === 'ArrowLeft' ? -1 : 1),
                );
                void commit();
              }
            }}
          >
            <span />
          </button>
          {/* Any earlier point can be clicked to start the comparison there. */}
          <div className={styles.stops}>
            {points.map((p, i) =>
              i < last ? (
                <button
                  key={p.id}
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  disabled={disabled}
                  style={{ left: `${(i / last) * 100}%` }}
                  data-selected={i >= position}
                  title={[t('Compare from {0}', label(i)), marks[i]?.hint]
                    .filter(Boolean)
                    .join('\n')}
                  onClick={() => choose(i)}
                />
              ) : (
                <span
                  key={p.id}
                  aria-hidden="true"
                  style={{ left: `${(i / last) * 100}%` }}
                  data-selected
                />
              ),
            )}
          </div>
          <input
            className={styles.handle}
            type="range"
            min={0}
            max={last}
            step={1}
            value={position}
            disabled={disabled}
            aria-label={t('Comparison starting point')}
            aria-valuetext={label(position)}
            onChange={(e) => preview(Number(e.target.value))}
            onPointerUp={() => void commit()}
            onPointerCancel={() => preview(selected)}
            onBlur={() => void commit()}
            onKeyUp={(e) => {
              if (
                [
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(e.key)
              )
                void commit();
            }}
          />
          <span className={styles.current} aria-hidden="true" />
          {marks.map(
            (m, i) =>
              m && (
                <span
                  key={points[i].id}
                  className={styles.decision}
                  data-tone={m.tone}
                  style={{ left: `${(i / last) * 100}%` }}
                  aria-hidden="true"
                >
                  <Icon name={m.icon} size={10} />
                </span>
              ),
          )}
        </div>
        <div className={styles.dates}>
          {points.map((p) => (
            <time key={p.id} dateTime={p.at}>
              {Number.isFinite(Date.parse(p.at))
                ? new Date(p.at).toLocaleString(getLanguage(), {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '—'}
            </time>
          ))}
        </div>
        <span className={styles.sr} aria-live="polite">
          {t('Comparison: {0} → {1}', label(position), label(last))}
          {marks.map((m, i) => m && ` · ${label(i)}: ${m.hint}`)}
        </span>
      </div>
    </div>
  );
}
