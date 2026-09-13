import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasEventAccess, hasRole, CHECKIN_ROLES } from '@/lib/auth';
import { badRequest, forbidden, notFound, respond, unauthorized } from '@/lib/api-helpers';
import { scannerHealthStatus } from '@/lib/scanner-operations';

export const GET = respond(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) throw unauthorized();
  if (!hasRole(session.user.role, CHECKIN_ROLES)) throw forbidden();
  const eventId = request.nextUrl.searchParams.get('eventId');
  if (!eventId) throw badRequest('Event ID is required');
  if (!hasEventAccess(session, eventId)) throw forbidden('You do not have access to this event');
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, capacity: true } });
  if (!event) throw notFound('Event not found');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [paid, checkedIn, todayLogs, recentLogs, heartbeats, shifts, incidents] = await Promise.all([
    prisma.ticket.count({ where: { eventId, status: { in: ['paid', 'partially_refunded'] } } }),
    prisma.ticket.count({ where: { eventId, checkedIn: true, status: { in: ['paid', 'partially_refunded'] } } }),
    prisma.checkInLog.findMany({ where: { eventId, createdAt: { gte: start }, action: { in: ['checkin', 'offline_checkin', 'manual_checkin'] } }, orderBy: { createdAt: 'asc' }, select: { action: true, deviceId: true, createdAt: true } }),
    prisma.checkInLog.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, action: true, deviceId: true, performedBy: true, performedRole: true, reason: true, createdAt: true, ticketId: true } }),
    prisma.scannerHeartbeat.findMany({ where: { eventId }, orderBy: { lastSeenAt: 'desc' }, take: 100 }),
    prisma.staffShift.findMany({ where: { eventId, endsAt: { gte: start } }, orderBy: { startsAt: 'asc' }, take: 100 }),
    prisma.operationalIncident.findMany({ where: { eventId, status: 'open' }, orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }], take: 50 }),
  ]);
  const hourly = new Array(24).fill(0) as number[];
  for (const log of todayLogs) hourly[new Date(log.createdAt).getHours()] += 1;
  const successful = new Set(['checkin', 'offline_checkin', 'manual_checkin']);
  return NextResponse.json({
    success: true,
    event,
    metrics: { capacity: event.capacity, paid, checkedIn, remaining: Math.max(0, paid - checkedIn), utilization: paid ? Number(((checkedIn / paid) * 100).toFixed(1)) : 0, today: todayLogs.length, manualToday: todayLogs.filter((log) => log.action === 'manual_checkin').length, offlineToday: todayLogs.filter((log) => log.action === 'offline_checkin').length, duplicateAttempts: recentLogs.filter((log) => ['duplicate_attempt', 'replay_detected'].includes(log.action)).length, activeDevices: heartbeats.filter((heartbeat) => scannerHealthStatus(heartbeat.lastSeenAt) === 'online').length },
    hourly,
    recent: recentLogs.filter((log) => successful.has(log.action) || ['duplicate_attempt', 'replay_detected'].includes(log.action)).slice(0, 25),
    devices: heartbeats.map((heartbeat) => ({ ...heartbeat, health: scannerHealthStatus(heartbeat.lastSeenAt) })),
    shifts,
    incidents,
  });
}, { auth: 'scanner' });
