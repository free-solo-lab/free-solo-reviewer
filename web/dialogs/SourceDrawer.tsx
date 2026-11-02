import { SourcePanel } from '../workspace/SourcePanel';
import { useWorkspace } from '../workspace/state';
import { Dialog } from '../ui/Dialog';
import { t } from '../../shared/i18n';

export function SourceDrawer() {
  const { setSource, sourceKeyboard } = useWorkspace();
  return (
    <Dialog
      variant="drawer"
      className="source-drawer"
      label={t('Source code')}
      onClose={() => setSource(null)}
      onKeyDownCapture={sourceKeyboard}
    >
      <SourcePanel />
    </Dialog>
  );
}
