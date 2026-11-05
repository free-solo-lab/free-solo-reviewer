let windowStart = 0,
  sent = 0;

/** Sends an interface error to the server's journal; a loop of errors is capped per minute. */
export function reportClientError(
  message: string,
  details?: string,
  level: 'warn' | 'error' = 'error',
) {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    sent = 0;
  }
  if (++sent > 20) return;
  void fetch('/api/logs/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: (message || 'Unknown error').slice(0, 2000),
      ...(details && { details: details.slice(0, 8000) }),
      level,
    }),
  }).catch(() => {
    /* A stopped server cannot log; the error stays in the browser console. */
  });
}

/** Script errors and rejected promises nobody handled, with their location in the code. */
export function captureClientErrors() {
  window.addEventListener('error', (event) =>
    reportClientError(
      event.message,
      event.error instanceof Error && event.error.stack
        ? event.error.stack
        : `${event.filename}:${event.lineno}:${event.colno}`,
    ),
  );
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    reportClientError(
      `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}
