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
    points.slice(0, last).findLast((p) => p.decision)?.decision === 'APPROVE';
  const mark = (p: ReviewPoint, i: number) =>
    p.decision === 'APPROVE'
      ? { tone: 'approved', text: t('Approved'), hint: t('You approved this version') }
      : p.decision === 'REQUEST_CHANGES'
        ? {
            tone: 'changes',
            text: t('Changes requested'),
            hint: t('You requested changes on this version'),
          }
        : i === last && stale
          ? {
              tone: 'stale',
              text: t('Review again'),
              hint: t('The code changed after your approval'),
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
                <strong>{label(i)}</strong>
              ) : (
                <button
                  disabled={disabled}
                  aria-pressed={i === position}
                  title={p.snapshots
                    .map((s) => `${s.repoName}: ${(i ? s.headSha : s.mergeBase).slice(0, 10)}`)
                    .join('\n')}
                  onClick={() => {
                    preview(i);
                    void commit();
                  }}
                >
                  {label(i)}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className={styles.axis} ref={axis}>
          <div className={styles.track} />
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
              if (drag.current?.pointerId !== e.pointerId) return;
              drag.current = undefined;
              e.currentTarget.releasePointerCapture(e.pointerId);
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
          <div className={styles.stops} aria-hidden="true">
            {points.map((p, i) => (
              <span
                key={p.id}
                style={{ left: `${(i / last) * 100}%` }}
                data-selected={i >= position}
                data-tone={marks[i]?.tone}
              />
            ))}
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
        {marks.some(Boolean) && (
          <div className={styles.marks}>
            {marks.map((m, i) => (
              <span key={points[i].id} data-tone={m?.tone} title={m?.hint}>
                {m && (
                  <>
                    {m.tone === 'approved' && <Icon name="check" size={11} />}
                    {m.text}
                  </>
                )}
              </span>
            ))}
          </div>
        )}
        <span className={styles.sr} aria-live="polite">
          {t('Comparison: {0} → {1}', label(position), label(last))}
        </span>
      </div>
    </div>
  );
}
