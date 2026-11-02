import { t } from '../shared/i18n';
/** A failed request; `code` names a known reason the page can offer a way out for. */
export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: { error?: string; code?: string } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) throw new Error(t('The server returned a response that is not JSON.'));
  }
  if (!response.ok) throw new ApiError(data?.error ?? `HTTP ${response.status}`, data?.code);
  return data as T;
}
