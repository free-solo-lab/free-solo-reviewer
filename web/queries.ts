import { useEffect } from 'react';
import { QueryClient, useQuery } from '@tanstack/react-query';
import type {
  GitHubAccounts,
  Repository,
  RepositoryBranches,
  ReviewRequest,
} from '../shared/model';
import type { FixAttention, FixCompletion } from '../shared/fix-chat';
import type { OnDemandStep, OptionalStep } from '../shared/analysis-steps';
import { api } from './api';
import { t } from '../shared/i18n';

export type StepSettings = { disabled: OptionalStep[]; onDemand: OnDemandStep[] };

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});
export const queryKeys = {
  repositories: ['repositories'],
  branches: (repoId: string) => ['branches', repoId],
  steps: ['settings', 'steps'],
  githubAccounts: ['github-accounts'],
  reviewRequests: (login: string | null | undefined) => ['review-requests', login ?? ''],
  sessions: ['sessions'],
  status: ['status'],
  fixAttention: ['fix-attention'],
  fixCompletions: (sessionId: string) => ['fix-completions', sessionId],
  feedback: ['feedback'],
  feedbackThread: (number: number) => ['feedback', number],
} as const;

export function useFixCompletions(sessionId?: string) {
  return (
    useQuery({
      queryKey: queryKeys.fixCompletions(sessionId ?? ''),
      enabled: !!sessionId,
      queryFn: () => api<FixCompletion[]>(`/sessions/${sessionId}/fix-completions`),
    }).data ?? []
  );
}

export type SessionList = import('../shared/session-list').SessionListItem[];
export interface AppStatus {
  login: string | null;
  githubError: string | null;
  codex: string | null;
  codexAuth: import('../shared/model').CodexAuth;
  dataDir?: string;
  demo?: boolean;
}

export const useRepositories = () =>
  useQuery({ queryKey: queryKeys.repositories, queryFn: () => api<Repository[]>('/repositories') });
/** Which analysis stages run with the review, on request per method or on request for all. */
export const useStepSettings = () =>
  useQuery({
    queryKey: queryKeys.steps,
    queryFn: () => api<StepSettings>('/settings/steps'),
  });
/** Fetched on every open of the form, so new branches show up without a reload. */
export const useRepositoryBranches = (repoId: string) =>
  useQuery({
    queryKey: queryKeys.branches(repoId),
    queryFn: () => api<RepositoryBranches>(`/repositories/${repoId}/branches`),
    staleTime: 0,
  });
export const useGitHubAccounts = () =>
  useQuery({
    queryKey: queryKeys.githubAccounts,
    queryFn: () => api<GitHubAccounts>('/github/accounts'),
  });
/**
 * PRs waiting for the current user's review, kept per user: switching shows the new user's
 * list loading at once and a previous user's list immediately.
 */
export function useReviewRequests() {
  const login = useGitHubAccounts().data?.current;
  return useQuery({
    queryKey: queryKeys.reviewRequests(login),
    queryFn: () =>
      api<ReviewRequest[]>(
        `/github/review-requests${login ? `?${new URLSearchParams({ login })}` : ''}`,
      ),
    enabled: login !== undefined,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}
/** Makes `login` the app's current GitHub user; null returns to the active gh account. */
export async function setCurrentGitHubUser(login: string | null) {
  const previous = queryClient.getQueryData<GitHubAccounts>(queryKeys.githubAccounts);
  // The menu and the request list switch at once; the server confirms the choice after.
  if (previous)
    queryClient.setQueryData(queryKeys.githubAccounts, {
      ...previous,
      current: login ?? previous.active,
    });
  try {
    queryClient.setQueryData(
      queryKeys.githubAccounts,
      await api<GitHubAccounts>('/github/current', 'PUT', { githubUser: login }),
    );
  } catch (error) {
    queryClient.setQueryData(queryKeys.githubAccounts, previous);
    throw error;
  }
  await queryClient.invalidateQueries({ queryKey: queryKeys.status });
}
export const useSessionList = () =>
  useQuery({ queryKey: queryKeys.sessions, queryFn: () => api<SessionList>('/sessions') });
export const useAppStatus = () =>
  useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api<AppStatus>('/status'),
    staleTime: Infinity,
  });

/** Questions from Codex stay visible on every page while their chat window is closed. */
export function useFixAttention() {
  const attention =
    useQuery({
      queryKey: queryKeys.fixAttention,
      queryFn: () => api<FixAttention[]>('/fix-chat/attention'),
      refetchInterval: 2000,
      refetchOnWindowFocus: true,
    }).data ?? [];
  useEffect(() => {
    if (!attention.length) return;
    const previous = document.title;
    document.title = t('● Codex is waiting for an answer — Review');
    return () => {
      document.title = previous;
    };
  }, [attention.length > 0]);
  return attention;
}

/**
 * The user's feedback issues with replies not read yet. GitHub is asked every few minutes and
 * when the window gets focus, so an answer shows up without opening the page.
 */
export const useFeedback = () =>
  useQuery({
    queryKey: queryKeys.feedback,
    queryFn: () => api<import('../shared/feedback').FeedbackList>('/feedback'),
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 60_000,
  });
export const useUnreadFeedback = () =>
  (useFeedback().data?.issues ?? []).reduce((n, issue) => n + issue.unread, 0);
