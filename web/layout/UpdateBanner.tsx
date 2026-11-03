import { useState } from 'react';
import { IconButton } from '../icons';
import { downloadPercent, useDesktopUpdate } from '../useDesktopUpdate';
import { getLanguage, t } from '../../shared/i18n';

/** Offers a downloaded release; checking and downloading stay quiet in Settings → About. */
export function UpdateBanner() {
  const update = useDesktopUpdate();
  const [hidden, setHidden] = useState('');
  const state = update?.state;
  if (!update || !state) return null;
  const release = 'version' in state ? state : state.state === 'error' ? state.update : undefined;
  // Failed checks (offline, GitHub down) are not worth a banner; a failed download is.
  if (!release || state.state === 'downloading') return null;
  const key = `${state.state}:${release.version}`;
  if (hidden === key) return null;
  const notes = (
    <a href={release.notesUrl} target="_blank" rel="noreferrer">
      {t('What’s new')}
    </a>
  );
  return (
    <div className={`alert ${state.state === 'error' ? 'error' : 'notice'}`} role="status">
      <span>
        {state.state === 'ready'
          ? t('Reviewer {0} is ready to install.', release.version)
          : state.state === 'installing'
            ? t('Installing Reviewer {0}…', release.version)
            : state.state === 'manual'
              ? t(
                  'Reviewer {0} is available. This copy cannot update itself: move it to Applications or download the new version.',
                  release.version,
                )
              : state.state === 'error'
                ? state.message
                : ''}{' '}
        {state.state === 'ready' &&
          release.kind !== 'patch' &&
          t('A copy of your review data is made before it is installed.')}{' '}
        {notes}
      </span>
      {state.state === 'ready' && (
        <button className="action primary" onClick={update.install}>
          {t('Restart and update')}
        </button>
      )}
      {state.state === 'manual' && (
        <button
          className="action"
          onClick={() => window.open(state.downloadUrl, '_blank', 'noreferrer')}
        >
          {t('Download')}
        </button>
      )}
      {state.state === 'error' && (
        <button className="action" onClick={update.check}>
          {t('Retry')}
        </button>
      )}
      {state.state !== 'installing' && (
        <IconButton
          icon="close"
          label={t('Later')}
          tooltip={false}
          onClick={() => setHidden(key)}
        />
      )}
    </div>
  );
}

/** One line for Settings → About. */
export function updateStatus(state: NonNullable<ReturnType<typeof useDesktopUpdate>>['state']) {
  if (!state) return '';
  switch (state.state) {
    case 'idle':
      return state.checkedAt
        ? t(
            'This is the latest version. Checked at {0}.',
            new Date(state.checkedAt).toLocaleTimeString(getLanguage(), {
              hour: '2-digit',
              minute: '2-digit',
            }),
          )
        : t('Updates are checked automatically.');
    case 'checking':
      return t('Looking for a new version…');
    case 'downloading':
      return t('Downloading Reviewer {0}: {1}%', state.version, downloadPercent(state));
    case 'ready':
      return t('Reviewer {0} is ready to install.', state.version);
    case 'manual':
      return t('Reviewer {0} is available.', state.version);
    case 'installing':
      return t('Installing Reviewer {0}…', state.version);
    case 'error':
      return state.message;
  }
}
