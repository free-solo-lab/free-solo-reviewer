import type { ReviewRequest } from './model.js';

/** Requests without activity for two weeks are usually stale: folded away and not counted. */
export const STALE_REQUEST_MS = 14 * 24 * 60 * 60 * 1000;
export const isStaleRequest = (request: ReviewRequest, now = Date.now()) =>
  Date.parse(request.updatedAt) < now - STALE_REQUEST_MS;
