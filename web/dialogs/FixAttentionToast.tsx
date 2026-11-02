import { useWorkspace } from '../workspace/state';
import { t } from '../../shared/i18n';

export function FixAttentionToast() {
  const { sessionData, setFixChatOpen, fixAttention, openSession, busy, afterLoad } =
    useWorkspace();
  return (
    <aside className="fix-attention-toast" role="status" aria-live="polite">
      <div>
        <strong>
          {fixAttention[0].kind === 'approval'
            ? t('Codex asks for approval')
            : t('Question from Codex')}
        </strong>
        <small>
          {fixAttention[0].title}
          {fixAttention.length > 1 ? t(' · {0} more', fixAttention.length - 1) : ''}
        </small>
        <p>{fixAttention[0].prompt}</p>
      </div>
      <button
        disabled={!!busy}
        onClick={() => {
          if (sessionData?.id === fixAttention[0].sessionId) return setFixChatOpen(true);
          afterLoad.current = () => setFixChatOpen(true);
          openSession(fixAttention[0].sessionId);
        }}
      >
        {fixAttention[0].kind === 'approval' ? t('View request') : t('Answer')}
      </button>
    </aside>
  );
}
