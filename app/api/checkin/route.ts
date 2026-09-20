import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateAuditChecksum, verifyTimedQRToken } from '@/lib/qr-security';
import { CheckInResponse } from '@/types';
import { consumeReplayNonce, enforceRateLimit } from '@/lib/rate-limit';
import { getSession, hasEventAccess } from '@/lib/auth';
import { ticketTokenMatches } from '@/lib/ticket-security';
import { isPaidLikeStatus, PAID_LIKE_STATUSES } from '@/lib/ticket-lifecycle';
import { isSecurityKeyBlocked, logSecurityEvent } from '@/lib/security-events';
import { manualCheckInAllowed } from '@/lib/checkin-policy';
import { readEventSettings } from '@/lib/event-settings';

const ALLOWED_ROLES = ['ADMIN', 'ORGANIZER', 'ORGANISER', 'SCANNER'];

// Simple in-memory nonce set to prevent replay within server lifetime
// In production use Redis or a DB table
async function logDuplicateAttempt(params: {
  ticketId: string;
  eventId: string;
  action: 'duplicate_attempt' | 'replay_detected';
  userId: string;
  role: string;
  req: NextRequest;
}) {
  const { ticketId, eventId, action, userId, role, req } = params;
  try {
    const timestamp = new Date();
    await prisma.checkInLog.create({
      data: {
        ticketId,
        eventId,
        action,
        performedBy: userId,
        performedRole: role,
        ipAddress: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown',
        userAgent: req.headers.get('user-agent') || 'unknown',
        checksum: generateAuditChecksum(ticketId, action, timestamp.toISOString(), userId),
        createdAt: timestamp,
      },
    });
  } catch {
    // Logging failure should not block check-in
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Authentication required' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const role = session.user.role;

    const rateLimited = await enforceRateLimit(req, 'checkin-post', { requests: 120, window: '1 m' }, userId);
    if (rateLimited) return rateLimited;

    if (!ALLOWED_ROLES.includes(role)) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Insufficient permissions for check-in' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { ticketId, token, timedToken, deviceId, deviceName, offlineTimestamp, reason, eventId: expectedEventId } = body;
    const action = body.action || 'checkin';
    if (!['checkin', 'manual_checkin', 'undo_checkin'].includes(action)) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Unsupported check-in action' },
        { status: 400 }
      );
    }

    if (!ticketId) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Ticket ID is required' },
        { status: 400 }
      );
    }

    const invalidTicketKey = `ticket:${ticketId}`;
    if (await isSecurityKeyBlocked('invalid_checkin_token', invalidTicketKey, 10, 10 * 60 * 1000)) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Too many invalid scan attempts for this ticket. Try again later.' },
        { status: 429 }
      );
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { Event: true },
    });

    if (!ticket) {
      await logSecurityEvent(req, {
        type: 'invalid_ticket_id',
        key: `user:${userId}`,
        ticketId,
      });
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Ticket not found' },
        { status: 404 }
      );
    }

    if (!isPaidLikeStatus(ticket.status)) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: `Ticket payment is ${ticket.status}` },
        { status: 400 }
      );
    }

    if (expectedEventId && ticket.eventId !== expectedEventId) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'This ticket belongs to a different event. Unlock the scanner to change events.' },
        { status: 409 }
      );
    }

    if (!hasEventAccess(session, ticket.eventId)) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'You do not have access to this event' },
        { status: 403 }
      );
    }

    if (action === 'manual_checkin') {
      const config = await prisma.siteConfig.findUnique({ where: { id: 'default' }, select: { settings: true } });
      if (!manualCheckInAllowed(config?.settings, ticket.eventId, role)) {
        return NextResponse.json<CheckInResponse>(
          { success: false, message: 'Manual check-in is not approved for this event' },
          { status: 403 }
        );
      }
    }
    if (action === 'undo_checkin' && !String(reason || '').trim()) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'An undo reason is required' },
        { status: 400 }
      );
    }

    // --- Token verification: support timed QR tokens OR plain HMAC tokens ---
    let tokenValid = false;

    if (action === 'manual_checkin' || action === 'undo_checkin') {
      tokenValid = true;
    } else if (timedToken && ticket.token) {
      // Timed QR token (enhanced security with expiry + replay protection)
      const qrResult = verifyTimedQRToken(timedToken, ticket.token);
      if (!qrResult.valid) {
        await logSecurityEvent(req, {
          type: 'invalid_checkin_token',
          key: invalidTicketKey,
          ticketId,
          eventId: ticket.eventId,
          details: { reason: qrResult.reason || 'invalid_timed_qr' },
        });
        return NextResponse.json<CheckInResponse>(
          { success: false, message: qrResult.reason || 'Invalid timed QR token' },
          { status: 403 }
        );
      }
      // Replay protection: extract nonce and check
      const parts = timedToken.split(':');
      const nonce = parts[3];
      if (nonce && !(await consumeReplayNonce(nonce))) {
        await logDuplicateAttempt({ ticketId, eventId: ticket.eventId, action: 'replay_detected', userId, role, req });
        return NextResponse.json<CheckInResponse>(
          { success: false, message: 'QR code already used (replay detected)' },
          { status: 403 }
        );
      }
      tokenValid = true;
    } else if (token) {
      // Plain token stored on the ticket (backwards compatible with generated HMAC tokens).
      if (!ticketTokenMatches(ticket.token, token)) {
        await logSecurityEvent(req, {
          type: 'invalid_checkin_token',
          key: invalidTicketKey,
          ticketId,
          eventId: ticket.eventId,
        });
        return NextResponse.json<CheckInResponse>(
          { success: false, message: 'Invalid ticket token' },
          { status: 403 }
        );
      }
      tokenValid = true;
    }

    if (!tokenValid) {
      await logSecurityEvent(req, {
        type: 'invalid_checkin_token',
        key: invalidTicketKey,
        ticketId,
        eventId: ticket.eventId,
        details: { reason: 'missing_token' },
      });
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Token is required for check-in' },
        { status: 400 }
      );
    }

    // --- Check-in vs Undo ---
    if (action === 'undo_checkin') {
      const config = await prisma.siteConfig.findUnique({ where: { id: 'default' }, select: { settings: true } });
      if (!readEventSettings(config?.settings, ticket.eventId).checkIn.allowUndo) {
        return NextResponse.json<CheckInResponse>({ success: false, message: 'Undo check-in is disabled for this event' }, { status: 403 });
      }
      if (!ticket.checkedIn) {
        return NextResponse.json<CheckInResponse>(
          { success: false, message: 'Ticket is not checked in' },
          { status: 400 }
        );
      }
      // Only ADMIN and ORGANIZER can undo
      if (!['ADMIN', 'ORGANIZER', 'ORGANISER'].includes(role)) {
        return NextResponse.json<CheckInResponse>(
          { success: false, message: 'Only admins and organizers can undo check-ins' },
          { status: 403 }
        );
      }

      const undoAt = new Date();
      const undoChecksum = generateAuditChecksum(ticketId, 'undo_checkin', undoAt.toISOString(), userId);

      const updatedTicket = await prisma.$transaction(async (tx) => {
        const updateResult = await tx.ticket.updateMany({
          where: { id: ticketId, checkedIn: true },
          data: { checkedIn: false, checkedInAt: null, checkedInBy: null },
        });

        if (updateResult.count !== 1) return null;

        await tx.checkInLog.create({
          data: {
            ticketId,
            eventId: ticket.eventId,
            action: 'undo_checkin',
            performedBy: userId,
            performedRole: role,
            ipAddress: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown',
            userAgent: req.headers.get('user-agent') || 'unknown',
            deviceId: deviceId || deviceName || null,
            reason: reason || null,
            checksum: undoChecksum,
            createdAt: undoAt,
          },
        });

        return tx.ticket.findUnique({
          where: { id: ticketId },
          include: { Event: true },
        });
      });

      if (!updatedTicket) {
        return NextResponse.json<CheckInResponse>(
          { success: false, message: 'Ticket is not checked in' },
          { status: 400 }
        );
      }

      return NextResponse.json<CheckInResponse>({
        success: true,
        message: 'Check-in undone',
        ticket: {
          id: updatedTicket.id, name: updatedTicket.name, email: updatedTicket.email,
          eventId: updatedTicket.eventId, checkedIn: updatedTicket.checkedIn,
          event: { name: updatedTicket.Event.name },
        },
      });
    }

    // --- Standard check-in ---
    if (ticket.checkedIn) {
      const latestCheckIn = await prisma.checkInLog.findFirst({
        where: { ticketId, action: { in: ['checkin', 'offline_checkin', 'manual_checkin'] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, performedBy: true, performedRole: true, deviceId: true },
      }).catch(() => null);
      await logDuplicateAttempt({ ticketId, eventId: ticket.eventId, action: 'duplicate_attempt', userId, role, req });
      return NextResponse.json<CheckInResponse>(
        {
          success: false,
          message: 'Ticket already checked in',
          ticket: {
            id: ticket.id, name: ticket.name, email: ticket.email,
            eventId: ticket.eventId, checkedIn: ticket.checkedIn,
            checkedInAt: ticket.checkedInAt,
            checkedInBy: ticket.checkedInBy,
            event: { name: ticket.Event.name },
            lastCheckIn: latestCheckIn,
          }
        },
        { status: 400 }
      );
    }

    const now = new Date();
    const actionAt = offlineTimestamp ? new Date(offlineTimestamp) : now;
    if (Number.isNaN(actionAt.getTime())) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Invalid offline timestamp' },
        { status: 400 }
      );
    }
    if (offlineTimestamp && (actionAt.getTime() > now.getTime() + 5 * 60 * 1000 || actionAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000)) {
      return NextResponse.json<CheckInResponse>(
        { success: false, message: 'Offline check-in timestamp is outside the allowed 24-hour sync window' },
        { status: 400 }
      );
    }
    const actionTimestamp = actionAt.toISOString();
    const checkinAction = action === 'manual_checkin' ? 'manual_checkin' : offlineTimestamp ? 'offline_checkin' : 'checkin';
    const checksum = generateAuditChecksum(ticketId, checkinAction, actionTimestamp, userId);

    // Use a conditional update so overlapping scans cannot both check in the same ticket.
    const updatedTicket = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.ticket.updateMany({
        where: {
          id: ticketId,
          checkedIn: false,
          status: { in: [...PAID_LIKE_STATUSES] },
        },
        data: {
          checkedIn: true,
          checkedInAt: actionAt,
          checkedInBy: userId,
        },
      });

      if (updateResult.count !== 1) return null;

      await tx.checkInLog.create({
        data: {
          ticketId,
          eventId: ticket.eventId,
          action: checkinAction,
          performedBy: userId,
          performedRole: role,
          ipAddress: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown',
          userAgent: req.headers.get('user-agent') || 'unknown',
          deviceId: deviceId || deviceName || null,
          reason: reason || null,
          checksum,
          syncedAt: offlineTimestamp ? now : null,
          createdAt: actionAt,
        },
      });

      return tx.ticket.findUnique({
        where: { id: ticketId },
        include: { Event: true },
      });
    });

    if (!updatedTicket) {
      const latestTicket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { Event: true },
      });

      if (latestTicket?.checkedIn) {
        const latestCheckIn = await prisma.checkInLog.findFirst({
          where: { ticketId, action: { in: ['checkin', 'offline_checkin', 'manual_checkin'] } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, performedBy: true, performedRole: true, deviceId: true },
        }).catch(() => null);
        await logDuplicateAttempt({ ticketId, eventId: ticket.eventId, action: 'duplicate_attempt', userId, role, req });
        return NextResponse.json<CheckInResponse>(
          {
            success: false,
            message: 'Ticket already checked in',
            ticket: {
              id: latestTicket.id, name: latestTicket.name, email: latestTicket.email,
              eventId: latestTicket.eventId, checkedIn: latestTicket.checkedIn,
              checkedInAt: latestTicket.checkedInAt,
              checkedInBy: latestTicket.checkedInBy,
              event: { name: latestTicket.Event.name },
              lastCheckIn: latestCheckIn,
            }
          },
          { status: 400 }
        );
      }

      return NextResponse.json<CheckInResponse>(
        { success: false, message: `Ticket payment is ${latestTicket?.status || ticket.status}` },
        { status: 400 }
      );
    }

    return NextResponse.json<CheckInResponse>({
      success: true,
      message: 'Check-in successful',
      ticket: {
        id: updatedTicket.id, name: updatedTicket.name, email: updatedTicket.email,
        eventId: updatedTicket.eventId, checkedIn: updatedTicket.checkedIn,
        event: { name: updatedTicket.Event.name }
      },
    });
  } catch (error) {
    console.error('Check-in error:', error);
    return NextResponse.json<CheckInResponse>(
      { success: false, message: 'Failed to process check-in' },
      { status: 500 }
    );
  }
}

// GET: Fetch check-in history/stats/logs for an event
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const rateLimited = await enforceRateLimit(req, 'checkin-get', { requests: 60, window: '1 m' }, session.user.id);
    if (rateLimited) return rateLimited;

    if (!ALLOWED_ROLES.includes(session.user.role)) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const url = new URL(req.url);
    const eventId = url.searchParams.get('eventId');
    const type = url.searchParams.get('type') || 'history';

    if (eventId && !hasEventAccess(session, eventId)) {
      return NextResponse.json({ error: 'You do not have access to this event' }, { status: 403 });
    }

    if (!eventId && session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Event ID is required' }, { status: 400 });
    }

    if (type === 'stats' && eventId) {
      const [total, checkedIn, recentCheckins] = await Promise.all([
        prisma.ticket.count({ where: { eventId, status: { in: [...PAID_LIKE_STATUSES] } } }),
        prisma.ticket.count({ where: { eventId, status: { in: [...PAID_LIKE_STATUSES] }, checkedIn: true } }),
        prisma.ticket.findMany({
          where: { eventId, status: { in: [...PAID_LIKE_STATUSES] }, checkedIn: true },
          orderBy: { checkedInAt: 'desc' },
          take: 20,
          include: { Event: { select: { name: true } } },
        }),
      ]);

      // Hourly breakdown for chart
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let hourlyBreakdown = new Array(24).fill(0);
      try {
        const hourlyLogs = await prisma.checkInLog.findMany({
          where: { eventId, action: { in: ['checkin', 'offline_checkin', 'manual_checkin'] }, createdAt: { gte: today } },
          orderBy: { createdAt: 'asc' },
        });
        hourlyLogs.forEach((log: any) => { hourlyBreakdown[new Date(log.createdAt).getHours()]++; });
      } catch { /* CheckInLog table may not exist yet */ }

      return NextResponse.json({
        total,
        checkedIn,
        pending: total - checkedIn,
        checkInRate: total > 0 ? ((checkedIn / total) * 100).toFixed(1) : '0',
        hourlyBreakdown: hourlyBreakdown.map((count, hour) => ({ hour: `${hour.toString().padStart(2, '0')}:00`, count })),
        recentCheckins: recentCheckins.map((t: any) => ({
          id: t.id,
          name: t.name,
          email: t.email,
          eventName: t.Event.name,
          checkedInAt: t.checkedInAt?.toISOString(),
        })),
      });
    }

    if (type === 'logs' && eventId) {
      try {
        const logs = await prisma.checkInLog.findMany({
          where: { eventId },
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: { ticket: { select: { name: true, email: true } } },
        });
        return NextResponse.json(logs);
      } catch {
        return NextResponse.json([]);
      }
    }

    // Default: history of checked-in tickets
    const where: any = { checkedIn: true, status: { in: [...PAID_LIKE_STATUSES] } };
    if (eventId) where.eventId = eventId;

    const checkedInTickets = await prisma.ticket.findMany({
      where,
      orderBy: { checkedInAt: 'desc' },
      take: 100,
      include: { Event: { select: { name: true } } },
    });

    return NextResponse.json(checkedInTickets.map((t: any) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      eventName: t.Event.name,
      checkedInAt: t.checkedInAt?.toISOString(),
      checkedInBy: t.checkedInBy,
    })));
  } catch (error) {
    console.error('Check-in history error:', error);
    return NextResponse.json({ error: 'Failed to fetch check-in data' }, { status: 500 });
  }
}
