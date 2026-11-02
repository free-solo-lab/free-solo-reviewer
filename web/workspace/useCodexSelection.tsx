import { useEffect, useState } from 'react';
import type { Evidence } from '../../shared/model';
import { useWorkspace } from './state';
import { api } from '../api';
import { Icon, IconButton } from '../icons';
import { t } from '../../shared/i18n';
import styles from './CodexSelection.module.css';

export interface CodexComment {
  id: string;
  repoId: string;
  body: string;
  evidence?: Evidence | null;
  discussionId?: string;
}
const key = (item: CodexComment) => `${item.repoId}:${item.discussionId ?? item.id}`;

/** One explicit packet, shared by the comments page and review dialog. */
export function useCodexSelection(onStarted?: () => void) {
  const { sessionData, drafts, updateDraft, saveDrafts, task, busy, setFixChatOpen } =
    useWorkspace();
  const [selected, setSelected] = useState<CodexComment[]>([]);
  useEffect(() => setSelected([]), [sessionData?.id]);
  const run = (together: boolean, only?: CodexComment) =>
    void task(t('Starting Codex fixes'), async () => {
      if (!sessionData) return;
      const packet = only ? [only] : selected;
      if (!packet.length) return;
      const repoId = packet[0].repoId;
      const snapshot = sessionData.snapshots.find((s) => s.repoId === repoId);
      const draft = drafts.find((d) => d.snapshotId === snapshot?.id && d.state === 'draft');
      if (!draft || packet.some((c) => c.repoId !== repoId))
        throw new Error(t('Select comments from one repository.'));
      const comments = [...draft.comments];
      const ids: string[] = [];
      for (const item of packet) {
        const index = comments.findIndex((c) =>
          item.discussionId ? c.discussionId === item.discussionId : c.id === item.id,
        );
        if (index >= 0) {
          comments[index] = { ...comments[index], forCodex: true, selected: false };
          ids.push(comments[index].id);
        } else {
          const id = crypto.randomUUID();
          comments.push({
            id,
            body: item.body,
            evidence: item.evidence ?? null,
            discussionId: item.discussionId,
            forCodex: true,
            selected: false,
          });
          ids.push(id);
        }
      }
      updateDraft({ ...draft, comments });
      await saveDrafts();
      await api(`/sessions/${sessionData.id}/fix-chat`, 'POST', {
        repoId,
        action: 'step',
        commentIds: ids,
        together,
        all: !together,
      });
      setSelected([]);
      onStarted?.();
      setFixChatOpen(true);
    });
  return {
    selected,
    busy: !!busy || sessionData?.run?.state === 'running',
    run,
    has: (item: CodexComment) => selected.some((c) => key(c) === key(item)),
    toggle: (item: CodexComment) =>
      setSelected((items) =>
        items.some((c) => key(c) === key(item))
          ? items.filter((c) => key(c) !== key(item))
          : [...items.filter((c) => c.repoId === item.repoId), item],
      ),
    clear: () => setSelected([]),
  };
}
export function CodexSelectionActions({
  selection,
}: {
  selection: ReturnType<typeof useCodexSelection>;
}) {
  if (!selection.selected.length) return null;
  return (
    <div className={styles.toolbar}>
      <span>{t('Selected: {0}', selection.selected.length)}</span>
      <button disabled={selection.busy} onClick={() => selection.run(true)}>
        <Icon name="play" size={14} />
        {t('Run together')}
      </button>
      <button disabled={selection.busy} onClick={() => selection.run(false)}>
        <Icon name="play" size={14} />
        {t('Run sequentially')}
      </button>
      <IconButton icon="close" label={t('Clear selection')} onClick={selection.clear} />
    </div>
  );
}
