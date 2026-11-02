import { Icon, IconButton } from '../icons';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useMatch } from 'react-router';
import { useTheme } from '../theme';
import { tabs, tabIcons } from '../workspace/tabs';
import { useWorkspace } from '../workspace/state';
import { cx } from '../ui/cx';
import {
  useGitHubAccounts,
  useReviewRequests,
  useUnreadFeedback,
  setCurrentGitHubUser,
} from '../queries';
import { GitHubLoginDialog } from '../dialogs/GitHubLoginDialog';
import { CodexLoginDialog } from '../dialogs/CodexLoginDialog';
import { errorMessage } from '../../shared/errors';
import { SkeletonRows } from '../ui/Skeleton';
import { isStaleRequest } from '../../shared/review-requests';
import styles from './Sidebar.module.css';
import { t } from '../../shared/i18n';
import { sessionListItem } from '../../shared/session-list';
import { ReviewListItem } from './ReviewListItem';

export function Sidebar() {
  const settings = !!useMatch('/settings/*');
  const statistics = !!useMatch('/settings/statistics');
  const issues = !!useMatch('/settings/issues');
  const unreadFeedback = useUnreadFeedback();
  // Both hooks run on every render: a short-circuit would change the hook order.
  const generalPage = !!useMatch('/settings/general'),
    settingsRoot = !!useMatch('/settings');
  const general = generalPage || settingsRoot;
  const settingsSection = statistics
    ? 'statistics'
    : issues
      ? 'issues'
      : general
        ? 'general'
        : 'analysis';
  const requestsPage = !!useMatch('/requests');
  const reviewRequests = useReviewRequests();
  // Only fresh requests are counted; stale ones stay folded on the page.
  const freshRequests = (reviewRequests.data ?? []).filter((request) => !isStaleRequest(request));
  const location = useLocation();
  const from =
    typeof location.state?.from === 'string' && location.state.from.startsWith('/sessions/')
      ? location.state.from
      : '/';
  const {
    sessions,
    sessionsLoading,
    sessionData,
    setDeleteTarget,
    fixAttention,
    session,
    liveRun,
    tab,
    setTab,
    openSession,
    drafts,
    status,
    busy,
    setError,
    setSetup,
    shownTabs,
  } = useWorkspace();
  // Tasks for Codex are counted on the fix button, not as review comments.
  const reviewComments = drafts.reduce(
    (n, d) => n + d.comments.filter((comment) => !comment.forCodex).length,
    0,
  );
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandMark}>
          r<span>•</span>
        </div>
        review
        <span className={styles.alpha} title={t('Alpha version: features and data may change.')}>
          alpha
        </span>
      </div>
      {settings ? (
        <>
          <Link to={from} className={styles.sidebarRow}>
            <Icon name="arrowLeft" />
            <span className={styles.sidebarRowLabel}>{t('Back to reviews')}</span>
          </Link>
          <h2 className={styles.settingsHeading}>{t('Settings')}</h2>
          <nav aria-label={t('Settings sections')}>
            {(
              [
                ['general', '/settings/general', 'settings', t('General')],
                ['analysis', '/settings/analysis', 'sparkles', t('Analysis and prompts')],
                ['statistics', '/settings/statistics', 'history', t('Analysis statistics')],
                ['issues', '/settings/issues', 'message', t('Issues')],
              ] as const
            ).map(([id, to, icon, label]) => (
              <Link
                key={id}
                to={to}
                state={location.state}
                className={cx(styles.sidebarRow, settingsSection === id && styles.active)}
                aria-current={settingsSection === id ? 'page' : undefined}
                title={label}
              >
                <Icon name={icon} />
                <span className={styles.sidebarRowLabel}>{label}</span>
                {id === 'issues' && unreadFeedback > 0 && (
                  <i className={styles.unread} aria-label={t('New replies: {0}', unreadFeedback)}>
                    {unreadFeedback}
                  </i>
                )}
              </Link>
            ))}
          </nav>
        </>
      ) : (
        <>
          <button
            className={cx(styles.sidebarRow, styles.newSession)}
            onClick={() => setSetup(true)}
          >
            <Icon name="plus" />
            {t('New review')}
          </button>
          {/* The sections belong to an open review; without one there is nothing to show. */}
          {/* Sections stay in place; ones with nothing to show in this review are disabled. */}
          <nav aria-label={t('Sections')}>
            {tabs.map(([id, label]) => {
              const empty = !session || !shownTabs.includes(id);
              return (
                <button
                  key={id}
                  className={cx(styles.sidebarRow, session && tab === id && styles.active)}
                  disabled={empty}
                  aria-current={session && tab === id ? 'page' : undefined}
                  onClick={() => setTab(id)}
                  title={
                    !session
                      ? t('Open a review to see its sections')
                      : empty
                        ? t('Nothing to show in this review')
                        : label
                  }
                >
                  <Icon name={tabIcons[id]} />
                  <span className={styles.sidebarRowLabel}>{label}</span>
                  {id === 'review' && reviewComments > 0 && <i>{reviewComments}</i>}
                </button>
              );
            })}
          </nav>
          <div className={cx(styles.navLabel, styles.sessionsLabel)}>
            {t('Review')} <span>{sessions.length}</span>
          </div>
          <div className={styles.sessionList}>
            {sessions.map((s) => (
              <ReviewListItem
                key={s.id}
                item={s.id === sessionData?.id ? sessionListItem(sessionData) : s}
                selected={session?.id === s.id}
                needsAnswer={fixAttention.some((item) => item.sessionId === s.id)}
                onOpen={() => openSession(s.id)}
                deleteDisabled={
                  !!busy ||
                  s.state === 'running' ||
                  (s.id === sessionData?.id && liveRun?.state === 'running')
                }
                onDelete={() => {
                  setError('');
                  setDeleteTarget(s);
                }}
              />
            ))}
            {sessionsLoading ? (
              <SkeletonRows
                count={4}
                label={t('Loading reviews')}
                className={styles.sessionSkeleton}
              />
            ) : (
              !sessions.length && (
                <p className={styles.sidebarHint}>{t('Your reviews will appear here')}</p>
              )
            )}
          </div>
          {/* Requests from GitHub are not reviews yet; they stay apart from the saved ones. */}
          <div className={styles.requestsSection}>
            <Link
              to="/requests"
              className={cx(styles.sidebarRow, requestsPage && styles.active)}
              aria-current={requestsPage ? 'page' : undefined}
              title={t('PRs waiting for your review')}
            >
              <Icon name="pullRequest" />
              <span className={styles.sidebarRowLabel}>{t('Review requests')}</span>
              {reviewRequests.isPending ? (
                <span className="spinner" role="status" aria-label={t('Loading review requests')} />
              ) : (
                freshRequests.length > 0 && <i>{freshRequests.length}</i>
              )}
            </Link>
          </div>
        </>
      )}
      <div
        className={styles.sidebarBottom}
        title={status?.login ? t('Local · GitHub CLI') : t('Run gh auth login')}
      >
        <UserMenu login={status?.login} codexConnected={!!status?.codexAuth || !!status?.demo} />
        <ThemeButton />
      </div>
    </aside>
  );
}

function UserMenu({ login, codexConnected }: { login?: string | null; codexConnected: boolean }) {
  const location = useLocation();
  const accounts = useGitHubAccounts();
  const github = accounts.data;
  const unreadFeedback = useUnreadFeedback();
  const [open, setOpen] = useState(false),
    [loggingIn, setLoggingIn] = useState(false),
    [connectingCodex, setConnectingCodex] = useState(false),
    [error, setError] = useState('');
  const current = github?.current ?? login;
  // Until gh answers, the account is unknown rather than missing.
  const checking = !current && accounts.isPending;
  const switchTo = (account: string | null) => {
    setOpen(false);
    setError('');
    setCurrentGitHubUser(account).catch((cause) => setError(errorMessage(cause)));
  };
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div
      ref={ref}
      className={styles.userMenu}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={button}
        className={styles.userButton}
        aria-label={t('User menu')}
        aria-expanded={open}
        aria-controls="user-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar}>
          {checking ? <span className="spinner" /> : (current?.slice(0, 2).toUpperCase() ?? 'GH')}
          {unreadFeedback > 0 && (
            <span className={styles.avatarDot} aria-label={t('New replies to your issues')} />
          )}
        </span>
        <span className={styles.sidebarBottomName}>
          {current ?? (checking ? t('Checking GitHub…') : t('GitHub is not connected'))}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} />
      </button>
      {open && (
        <nav id="user-menu" className={styles.userPopup} aria-label={t('User menu')}>
          {!!github?.accounts.length && (
            <div role="group" aria-label={t('GitHub user')} className={styles.accounts}>
              <small>{t('GitHub user')}</small>
              {github.accounts.map((account) => (
                <button
                  key={account}
                  aria-pressed={account === current}
                  onClick={() => switchTo(account === github.active ? null : account)}
                >
                  <span className={styles.avatar}>{account.slice(0, 2).toUpperCase()}</span>
                  <span className={styles.sidebarBottomName}>{account}</span>
                  {account === current && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              setOpen(false);
              setLoggingIn(true);
            }}
          >
            <Icon name="user" />
            {t('Add account…')}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              setConnectingCodex(true);
            }}
          >
            <Icon name="sparkles" />
            {codexConnected ? t('Codex is connected · change…') : t('Connect Codex…')}
          </button>
          <Link
            to={unreadFeedback > 0 ? '/settings/issues' : '/settings/general'}
            state={{
              from: location.pathname.startsWith('/sessions/')
                ? location.pathname + location.search
                : '/',
            }}
            onClick={() => setOpen(false)}
          >
            <Icon name="settings" />
            {t('Settings')}
            {unreadFeedback > 0 && (
              <i className={styles.unread}>{t('New replies: {0}', unreadFeedback)}</i>
            )}
          </Link>
        </nav>
      )}
      {error && (
        <p className={styles.userError} role="alert">
          {error}
        </p>
      )}
      {connectingCodex && <CodexLoginDialog onClose={() => setConnectingCodex(false)} />}
      {loggingIn && (
        <GitHubLoginDialog
          onClose={() => setLoggingIn(false)}
          onDone={(account) => {
            setLoggingIn(false);
            switchTo(account);
          }}
        />
      )}
    </div>
  );
}

const themes = {
  system: { icon: 'monitor', label: t('Theme: system'), next: 'light' },
  light: { icon: 'sun', label: t('Theme: light'), next: 'dark' },
  dark: { icon: 'moon', label: t('Theme: dark'), next: 'system' },
} as const;
function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const { icon, label, next } = themes[theme];
  return <IconButton icon={icon} label={label} onClick={() => setTheme(next)} />;
}
