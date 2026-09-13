export type ScannerHealthStatus = 'online' | 'degraded' | 'offline';

export function scannerHealthStatus(lastSeenAt: Date | null, now = new Date(), onlineMs = 45_000, degradedMs = 180_000): ScannerHealthStatus {
  if (!lastSeenAt) return 'offline';
  const age = Math.max(0, now.getTime() - lastSeenAt.getTime());
  if (age <= onlineMs) return 'online';
  if (age <= degradedMs) return 'degraded';
  return 'offline';
}
