export function isInternalUrl(url: string, service: string) {
  try {
    return new URL(url).origin === new URL(service).origin;
  } catch {
    return false;
  }
}
export function externalUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return;
  }
}
