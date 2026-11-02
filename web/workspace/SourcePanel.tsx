import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Evidence } from '../../shared/model';
import { Icon, IconButton } from '../icons';
import { SourceCode } from '../components';
import { api } from '../api';
import { useWorkspace } from './state';
import { editableLineChunks, isWrongBranch } from '../../shared/code-edits';
import styles from './SourcePanel.module.css';
import { DefinitionPicker } from './DefinitionPicker';
import {
  CodeBuffer,
  codeBuffers,
  flushCodeBuffers,
  hasPendingCode,
  type CodeCaret,
} from './code-buffer';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';
import { reviewSnapshotId } from '../../shared/review-timeline';

/** The addressee chosen last stays for the next comment, e.g. a series of tasks for Codex. */
let lastForCodex = false;
/** Keep the warning active even when the user leaves the code page with pending edits. */
export function useCodeEditsWarning() {
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasPendingCode()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const flush = () => {
      void flushCodeBuffers();
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('blur', flush);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('blur', flush);
    };
  }, []);
}

/** The open file; `actions` adds controls of the page that hosts it to its header. */
export function SourcePanel({
  actions,
  inline = false,
  ranges,
  flow = false,
}: {
  actions?: ReactNode;
  inline?: boolean;
  ranges?: Evidence[];
  flow?: boolean;
}) {
  const commentFieldId = useId();
  const [forCodex, setForCodexState] = useState(lastForCodex);
  const [buffer, setBuffer] = useState<{ key: string; value: CodeBuffer } | null>(null);
  const [editError, setEditError] = useState('');
  const [switching, setSwitching] = useState(false);
  const setForCodex = (value: boolean) => {
    lastForCodex = value;
    setForCodexState(value);
  };
  const {
    sessionData,
    tab,
    drafts,
    source,
    setSource,
    comment,
    setComment,
    sourceNavigation,
    definitionPicker,
    setDefinitionPicker,
    sourceViewport,
    sourceComment,
    updateDraft,
    repoName,
    sourceSelection,
    sourceContext,
    sourceSnapshot,
    fileViews,
    methodViews,
    reviewDiscussion,
    sourceThreads,
    sourcePreviousDrafts,
    sourcePreviousThreads,
    sourceReadOnly,
    sourceComments,
    sourceChangedFile,
    codeLinks,
    navigateDefinition,
    followDefinition,
    sourceBack,
    addComment,
    navigatePreviousCode,
  } = useWorkspace();
  const fileKey = source
    ? `${sessionData?.id}:${sourceSnapshot?.id}:${source.evidence.repoId}:${source.evidence.path}`
    : '';
  const currentKey = useRef(fileKey);
  currentKey.current = fileKey;
  const canEdit =
    !!source &&
    !sourceReadOnly &&
    source.evidence.side === 'head' &&
    !!(sourceSnapshot?.local || sourceSnapshot?.pr);
  const activeBuffer = buffer?.key === fileKey && canEdit ? buffer.value : null;
  const activeEdit = useSyncExternalStore(
    activeBuffer?.subscribe ?? (() => () => {}),
    activeBuffer?.getSnapshot ?? (() => null),
    () => null,
  );
  const updateEditing = (chunks: string[], caret?: CodeCaret) =>
    activeBuffer?.change(chunks, caret);
  const loadEdit = async () => {
    if (!source || !canEdit) return;
    const key = fileKey;
    setEditError('');
    try {
      await flushCodeBuffers();
      const file = await api<{ content: string; hash: string }>(
        `/sessions/${sessionData!.id}/working-file?${new URLSearchParams({
          repoId: source.evidence.repoId,
          path: source.evidence.path,
        })}`,
      );
      if (currentKey.current !== key) return;
      const existing = codeBuffers.get(key);
      if (existing && (existing.dirty || existing.getSnapshot().hash === file.hash))
        setBuffer({ key, value: existing });
      else {
        const sessionId = sessionData!.id;
        const repoId = source.evidence.repoId,
          path = source.evidence.path;
        const value = new CodeBuffer(
          editableLineChunks(source.text, file.content),
          file.hash,
          (content, hash) =>
            api(`/sessions/${sessionId}/working-file`, 'PUT', { repoId, path, content, hash }),
        );
        codeBuffers.set(key, value);
        setBuffer({ key, value });
      }
    } catch (error) {
      if (currentKey.current !== key) return;
      setEditError(errorMessage(error));
    }
  };
  /** Puts the working folder on the PR branch, then opens the file for editing again. */
  const switchBranch = async () => {
    if (!source || !sessionData) return;
    setSwitching(true);
    try {
      await api(`/sessions/${sessionData.id}/checkout`, 'POST', {
        repoId: source.evidence.repoId,
      });
      await loadEdit();
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setSwitching(false);
    }
  };
  useEffect(() => {
    setEditError('');
    if (!canEdit) {
      setBuffer(null);
      return;
    }
    const cached = codeBuffers.get(fileKey);
    if (cached && (cached.dirty || cached.getSnapshot().saving))
      setBuffer({ key: fileKey, value: cached });
    else {
      setBuffer(null);
      void loadEdit();
    }
  }, [fileKey, canEdit, source?.visitId]);
  useEffect(
    () => () => {
      void activeBuffer?.flush();
    },
    [activeBuffer],
  );
  if (!source) return null;
  const commentForm = sourceSelection ? (
    <div className="source-comment">
      <button
        className="source-comment-close"
        aria-label={t('Cancel comment')}
        title={t('Cancel comment')}
        onClick={() => {
          setComment('');
          sourceComment.current = '';
          setSource({ ...source, selection: undefined });
        }}
      >
        <Icon name="close" />
      </button>
      <label htmlFor={commentFieldId} className="field-label">
        {t('Comment')}{' '}
        {sourceSelection!.startLine === sourceSelection!.endLine
          ? t('on line {0}', sourceSelection!.startLine)
          : t('on lines {0}–{1}', sourceSelection!.startLine, sourceSelection!.endLine)}
        {sourceSelection!.side !== source.evidence.side
          ? sourceSelection!.side === 'base'
            ? t(' · before the change')
            : t(' · after the change')
          : ''}
      </label>
      <div className="view-switch" role="radiogroup" aria-label={t('Comment recipient')}>
        {(
          [
            [false, t('In the review')],
            [true, t('For Codex')],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            role="radio"
            aria-checked={forCodex === value}
            className={forCodex === value ? 'active' : undefined}
            onClick={() => setForCodex(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        id={commentFieldId}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={forCodex ? t('What should Codex fix here…') : t('Describe the remark…')}
      />
      <button
        className="primary"
        disabled={!comment.trim()}
        onClick={() => {
          if (addComment(comment, sourceSelection!, forCodex)) {
            setComment('');
            setSource({ ...source, selection: undefined });
          }
        }}
      >
        {forCodex ? t('Add to the Codex plan') : t('Add to draft')}
      </button>
    </div>
  ) : null;
  return (
    <>
      {/* In a scenario's code flow the block heading names the class; the path is not repeated. */}
      {!flow && (
        <header className={styles.header}>
          {!flow && (
            <div className={styles.history} aria-label={t('Code browsing history')}>
              <IconButton
                icon="arrowLeft"
                label={t('Back · ⌘[ or Alt+←')}
                disabled={!sourceNavigation.back.length}
                onClick={() => sourceBack()}
              />
              <IconButton
                icon="arrowRight"
                label={t('Forward · ⌘] or Alt+→')}
                disabled={!sourceNavigation.forward.length}
                onClick={() => sourceBack(true)}
              />
            </div>
          )}
          <div className={styles.file}>
            <h3 className={styles.path} title={source.evidence.path}>
              <span className={styles.dir}>{source.evidence.path.replace(/[^/]*$/, '')}</span>
              <span>{source.evidence.path.split('/').pop()}</span>
            </h3>
            <span className={styles.meta}>
              {repoName(source.evidence.repoId)} ·{' '}
              {sourceContext?.snapshots
                .find((snapshot) => snapshot.repoId === source.evidence.repoId)
                ?.headSha?.slice(0, 7)}
              {source.evidence.side === 'base' && t(' · before the change')}
            </span>
          </div>
          {actions}
          {tab !== 'review' && !inline && (
            <IconButton
              icon="close"
              label={t('Close code')}
              tooltip={false}
              onClick={() => setSource(null)}
            />
          )}
        </header>
      )}
      {source.comparison && (
        <p className={styles.note}>
          {t('Previous review')} {source.comparison.previousSha.slice(0, 7)} {t('→ current code')}{' '}
          {source.comparison.currentSha.slice(0, 7)}
          {source.comparison.file.status === 'unchanged' ? t(' · file unchanged') : ''}
        </p>
      )}
      {reviewDiscussion.error && (
        <p className={styles.loadError} role="alert">
          {reviewDiscussion.error}
        </p>
      )}
      {definitionPicker && (
        <DefinitionPicker
          link={definitionPicker}
          snapshots={sourceContext?.snapshots ?? []}
          indexes={
            source.navigationIndex
              ? [source.navigationIndex]
              : (sourceContext?.run?.result.indexes ?? [])
          }
          onSelect={(evidence, line) => void navigateDefinition(evidence, line)}
          onClose={() => setDefinitionPicker(null)}
        />
      )}
      {editError && !activeEdit?.error && (
        <p className={styles.editNote}>
          {editError}{' '}
          {isWrongBranch(editError) && sourceSnapshot?.pr ? (
            <button
              className="text-button"
              disabled={switching}
              onClick={() => void switchBranch()}
            >
              {switching ? t('Switching…') : t('Switch to {0}', sourceSnapshot.pr.headRefName)}
            </button>
          ) : (
            <button className="text-button" onClick={() => void loadEdit()}>
              {t('Retry')}
            </button>
          )}
        </p>
      )}
      {activeEdit?.error && (
        <p className={styles.loadError} role="alert">
          {activeEdit.error}{' '}
          <button className="text-button" onClick={() => void activeBuffer?.flush(true)}>
            {t('Retry')}
          </button>
        </p>
      )}
      <SourceCode
        ranges={ranges}
        autoScroll={!flow}
        changeNavigation={!flow}
        toolbarActions={
          <>
            {/* A scenario's code flow marks methods only, not whole files. */}
            {sourceSnapshot && !flow && (
              <label className="source-method-viewed">
                <input
                  type="checkbox"
                  checked={fileViews.isViewed(sourceSnapshot, source.evidence.path)}
                  disabled={
                    fileViews.loading || fileViews.isPending(sourceSnapshot, source.evidence.path)
                  }
                  onChange={(event) =>
                    void fileViews.setViewed(
                      sourceSnapshot,
                      source.evidence.path,
                      event.target.checked,
                    )
                  }
                />
                {t('Viewed')}
              </label>
            )}
          </>
        }
        inlineEditing={
          canEdit && activeEdit
            ? {
                chunks: activeEdit.chunks,
                onEdit: (chunks, caret) => updateEditing(chunks, caret),
                onSave: () => void activeBuffer?.flush(true),
                onUndo: (redo) => activeBuffer?.undo(redo),
              }
            : undefined
        }
        links={codeLinks}
        onDefinition={followDefinition}
        visitId={source.visitId}
        position={source.position}
        viewportRef={sourceViewport}
        text={source.text}
        evidence={source.evidence}
        selection={source.selection}
        changedFile={source.comparison?.file ?? (sourceChangedFile || undefined)}
        comparison={source.comparison}
        previousComments={sourcePreviousDrafts
          .flatMap((draft) => draft.comments)
          .filter(
            (comment) =>
              !sourcePreviousThreads.some((thread) => thread.localCommentId === comment.id),
          )}
        previousDiscussions={sourcePreviousThreads}
        onHistoricalSource={(evidence) => void navigatePreviousCode(evidence)}
        comments={sourceComments.filter(
          (comment) =>
            !comment.outdated &&
            !sourceThreads.some((thread) => thread.localCommentId === comment.id),
        )}
        deletableCommentIds={
          new Set(
            drafts
              .filter(
                (draft) =>
                  draft.state === 'draft' &&
                  draft.snapshotId === (sourceSnapshot && reviewSnapshotId(sourceSnapshot)),
              )
              .flatMap((draft) => draft.comments.map((comment) => comment.id)),
          )
        }
        discussions={sourceThreads}
        discussionSessionId={sessionData?.id}
        onDiscussionReply={reviewDiscussion.reply}
        onDiscussionReaction={reviewDiscussion.react}
        onDeleteComment={
          sourceReadOnly
            ? undefined
            : (id) => {
                const target = drafts.find(
                  (draft) =>
                    draft.snapshotId === (sourceSnapshot && reviewSnapshotId(sourceSnapshot)) &&
                    draft.headSha === sourceSnapshot?.headSha &&
                    draft.state === 'draft' &&
                    draft.comments.some((comment) => comment.id === id),
                );
                if (target)
                  updateDraft({
                    ...target,
                    comments: target.comments.filter((comment) => comment.id !== id),
                  });
              }
        }
        methods={methodViews.methods}
        methodPending={methodViews.pending}
        methodError={methodViews.error}
        onMethodViewed={(entry, viewed) => void methodViews.setViewed(entry, viewed)}
        commentEditor={sourceReadOnly ? undefined : commentForm}
        onSelect={(line, reference) =>
          setSource({
            ...source,
            selection: reference ?? { ...source.evidence, startLine: line, endLine: line },
          })
        }
      />
    </>
  );
}
