export interface CheckInPolicy {
  manualCheckInEnabled: boolean;
  organizerApprovedEventIds: string[];
}
export const DEFAULT_CHECKIN_POLICY: CheckInPolicy = {
  manualCheckInEnabled: false,
  organizerApprovedEventIds: [],
};

export function readCheckInPolicy(settings: unknown): CheckInPolicy {
  const source = settings && typeof settings === 'object'
    ? (settings as { checkInPolicy?: Partial<CheckInPolicy> }).checkInPolicy
    : undefined;
  return {
    manualCheckInEnabled: source?.manualCheckInEnabled === true,
    organizerApprovedEventIds: Array.isArray(source?.organizerApprovedEventIds)
      ? source.organizerApprovedEventIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export function manualCheckInAllowed(settings: unknown, eventId: string, role: string): boolean {
  if (role === 'ADMIN') return true;
  const policy = readCheckInPolicy(settings);
  const eventSettings = settings && typeof settings === 'object'
    ? (settings as { eventSettings?: Record<string, { checkIn?: { manualEnabled?: boolean } }> }).eventSettings?.[eventId]
    : undefined;
  const manualEnabled = eventSettings?.checkIn?.manualEnabled !== false;
  return policy.manualCheckInEnabled
    && manualEnabled
    && policy.organizerApprovedEventIds.includes(eventId);
}
