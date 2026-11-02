import type { Evidence } from '../../shared/model';
import { useWorkspace } from './state';

export function EvidenceLinks({
  refs,
  versionId: version,
}: {
  refs: Evidence[];
  versionId?: string;
}) {
  const { setDraftDialog, reviewVersion, tab, repoName, openSource } = useWorkspace();
  const versionId = version ?? reviewVersion?.id ?? 'current';
  return (
    <div className="evidence">
      {refs.map((e, i) => (
        <button
          key={i}
          onClick={() => {
            if (tab === 'review') setDraftDialog(false);
            void openSource(e, versionId);
          }}
          title={`${repoName(e.repoId)} · ${e.side}`}
        >
          <span>↗</span> {e.path.split('/').pop()}:{e.startLine}
        </button>
      ))}
    </div>
  );
}
