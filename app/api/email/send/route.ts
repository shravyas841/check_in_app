import { NextRequest, NextResponse } from 'next/server';
import { sendTicketEmail, TicketEmailData } from '@/lib/ticket-email';
import { getSession, hasEventAccess, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (!hasRole(session.user.role, ORGANIZER_ROLES)) return NextResponse.json({ error: 'Organizer role required' }, { status: 403 });

    const body: TicketEmailData = await request.json();

    if (!body.to || !body.ticketId || !body.eventName || typeof body.to !== 'string' || typeof body.ticketId !== 'string' || typeof body.eventName !== 'string') {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (body.to.length > 254 || body.eventName.length > 300 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) {
      return NextResponse.json({ error: 'Invalid email payload' }, { status: 400 });
    }

    const rateLimited = await enforceRateLimit(request, 'email-send', { requests: 10, window: '1 m' }, session.user.id);
    if (rateLimited) return rateLimited;

    const ticket = await prisma.ticket.findUnique({ where: { id: body.ticketId }, select: { eventId: true, email: true } });
    if (!ticket || !hasEventAccess(session, ticket.eventId)) {
      return NextResponse.json({ error: 'Ticket not found or access denied' }, { status: 403 });
    }
    if (!ticket.email || ticket.email.trim().toLowerCase() !== body.to.trim().toLowerCase()) {
      return NextResponse.json({ error: 'Recipient must match the ticket email' }, { status: 403 });
    }

    const result = await sendTicketEmail(body);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: 'Email sent successfully',
        messageId: (result as any).messageId,
      });
    } else {
      console.error('Email sending failed:', 'error' in result ? result.error : 'unknown provider error');
      return NextResponse.json({ error: 'Failed to send email' }, { status: 502 });
    }
  } catch (error) {
    console.error('Email error:', error);
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
