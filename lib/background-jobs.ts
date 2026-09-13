export type BackgroundJobStatus = 'pending' | 'processing' | 'completed' | 'dead_letter' | 'dismissed';

export function calculateJobBackoffMs(attempt: number, baseMs = 60_000, maxMs = 3_600_000) {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, baseMs * (2 ** (normalizedAttempt - 1)));
}

export function nextJobStatus(input: { attempts: number; maxAttempts: number; retryable: boolean }): BackgroundJobStatus {
  if (!input.retryable || input.attempts >= input.maxAttempts) return 'dead_letter';
  return 'pending';
}

export function isStaleJobClaim(lockedAt: Date | null, now = new Date(), staleAfterMs = 10 * 60_000) {
  return Boolean(lockedAt && now.getTime() - lockedAt.getTime() >= staleAfterMs);
}
