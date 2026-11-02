export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: { error?: string } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) throw new Error('Сервер вернул ответ не в формате JSON.');
  }
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}
