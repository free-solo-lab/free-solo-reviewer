import { isReviewerRuntime, serviceUrl, type ReviewerRuntime } from '../shared/runtime.js';
import { t } from '../shared/i18n.js';

export async function probeReviewer(
  port: number,
  timeoutMs = 1000,
  retry = true,
): Promise<ReviewerRuntime | undefined> {
  let response: Response;
  try {
    response = await fetch(`${serviceUrl(port)}/api/runtime`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') return;
    // A pooled keep-alive connection to a server that has just stopped is reset rather than
    // refused; a fresh connection tells a stopped server from a broken one.
    if (retry) return probeReviewer(port, timeoutMs, false);
    throw new Error(
      t('Could not check the Reviewer server on port {0}: {1}', port, (error as Error).message),
    );
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isReviewerRuntime(value))
    throw new Error(
      t(
        'Port {0} is used by another server or an incompatible Reviewer version. Free the port or set REVIEW_PORT.',
        port,
      ),
    );
  return value;
}
