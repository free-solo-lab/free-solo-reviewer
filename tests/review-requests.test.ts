import { expect, it } from 'vitest';
import { isStaleRequest, STALE_REQUEST_MS } from '../shared/review-requests';
import type { ReviewRequest } from '../shared/model';

it('treats requests without activity for two weeks as stale', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const request = (updatedAt: string) => ({ updatedAt }) as ReviewRequest;
  expect(isStaleRequest(request('2026-10-27T10:00:00Z'), now)).toBe(false);
  expect(isStaleRequest(request(new Date(now - STALE_REQUEST_MS + 1000).toISOString()), now)).toBe(
    false,
  );
  expect(isStaleRequest(request(new Date(now - STALE_REQUEST_MS - 1000).toISOString()), now)).toBe(
    true,
  );
  expect(isStaleRequest(request('2026-09-10T10:00:00Z'), now)).toBe(true);
});
