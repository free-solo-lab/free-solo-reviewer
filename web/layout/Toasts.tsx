import { IconButton } from '../icons';
import { useWorkspace } from '../workspace/state';
import { t } from '../../shared/i18n';

export function Toasts() {
  const { busy, analysisToast, setAnalysisToast } = useWorkspace();
  return (
    <>
      {busy && (
        <div className="busy-toast" role="status">
          <span className="spinner" />
          {busy}…
        </div>
      )}
      {!busy && analysisToast && (
        <div className="busy-toast analysis-toast" role="status" aria-live="polite">
          <span>{analysisToast.text}</span>
          <IconButton
            icon="close"
            label={t('Close notification')}
            tooltip={false}
            onClick={() => setAnalysisToast(null)}
          />
        </div>
      )}
    </>
  );
}
