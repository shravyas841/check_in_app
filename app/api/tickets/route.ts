import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@clerk/nextjs/server';
import { getSession, hasEventAccess } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getTicketFinancials, getTicketLifecycleStatus } from '@/lib/ticket-lifecycle';
import { EVENT_SELECT } from '@/lib/event-select';
import { paginationMeta, parseCursorPagination, parsePagination } from '@/lib/pagination';
import { apiErrorResponse } from '@/lib/api-helpers';
import { quoteTicketType } from '@/lib/ticket-types';

function serializeTicket(ticket: any) {
  const { Event, ...ticketData } = ticket;
  const financials = getTicketFinancials(ticketData, Event?.price || 0);
  return {
    ...ticketData,
    ...financials,
    lifecycleStatus: getTicketLifecycleStatus(ticketData),
    deliveryHistory: ticketData.DeliveryLogs || [],
    event: Event,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = await auth();
    const rateLimited = await enforceRateLimit(req, 'ticket-create', { requests: 20, window: '1 m' }, userId || body.email || undefined);
    if (rateLimited) return rateLimited;

    // Support both single and multi-ticket purchase
    const attendees = Array.isArray(body.attendees) && body.attendees.length > 0
      ? body.attendees
      : [{ name: body.name, email: body.email, phone: body.phone }];
    const quantity = Number(body.quantity || attendees.length || 1);

    // Validate required fields
    if (attendees.length === 0 || !body.eventId || attendees.some((attendee: any) => !String(attendee.name || '').trim())) {
      return NextResponse.json(
        { error: 'Name and event are required for every ticket' },
        { status: 400 }
      );
    }

    if (quantity !== attendees.length) {
      return NextResponse.json(
        { error: 'Ticket quantity does not match attendee count' },
        { status: 400 }
      );
    }

    if (quantity < 1 || quantity > 10) {
      return NextResponse.json(
        { error: 'You can register between 1 and 10 tickets per order' },
        { status: 400 }
      );
    }

    const event = await prisma.event.findUnique({
        where: { id: body.eventId },
        select: EVENT_SELECT,
    });

    if (!event) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }

    const eventName = event.name;
    const ticketType = body.ticketTypeId ? await prisma.ticketType.findFirst({ where: { id: body.ticketTypeId, eventId: event.id } }) : null;
    if (body.ticketTypeId && !ticketType) return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
    if (ticketType) {
      try { quoteTicketType(ticketType, quantity, Math.max(0, event.capacity - event.soldCount)); }
      catch (reason) { return NextResponse.json({ error: reason instanceof Error ? reason.message : 'Ticket type is unavailable' }, { status: 409 }); }
    }
    const eventPrice = ticketType?.price ?? event.price;

    // Check if event is active or global sales paused
    // Check Global Sales Pause
    const siteConfig = await prisma.siteConfig.findUnique({ where: { id: 'default' } });
    const settings = siteConfig?.settings as any;
    if (settings?.globalSalesPaused) {
      return NextResponse.json(
        { error: 'Ticket sales are currently paused globally.' },
        { status: 403 }
      );
    }

    // Note: We need to get global settings from DB or assume active. 
    // Since we don't have easy access to store settings here, we rely on event.isActive for now.
    // Ideally, global settings should be in DB. 
    // For now, we'll check event.isActive if event exists.
    if (event.publicationStatus !== 'published') {
      return NextResponse.json({ error: 'Event is not publicly available yet' }, { status: 404 });
    }
    if (!event.isActive) {
      return NextResponse.json(
        { error: 'Ticket sales are currently paused for this event' },
        { status: 403 }
      );
    }

    const paidTicketCount = await prisma.ticket.count({
      where: { eventId: event.id, status: { in: ['paid', 'partially_refunded'] } },
    });

    if (paidTicketCount + attendees.length > event.capacity) {
      return NextResponse.json(
        { error: 'Not enough tickets are available for this event' },
        { status: 409 }
      );
    }

    const tickets = await prisma.$transaction(
      attendees.map((attendee: any) => prisma.ticket.create({
        data: {
          id: crypto.randomUUID(),
          name: String(attendee.name || '').trim(),
          email: attendee.email || body.email || null,
          phone: attendee.phone || body.phone || null,
          userId: userId || null,
          eventId: body.eventId,
          ticketTypeId: ticketType?.id || null,
          status: 'pending',
          customAnswers: body.customAnswers || {},
          updatedAt: new Date(),
        },
      }))
    );

    const ticketIds = tickets.map((ticket) => ticket.id);

    return NextResponse.json({
      ticketId: ticketIds[0], // Primary ticket ID for backwards compatibility
      ticketIds, // All ticket IDs for multi-ticket
      quantity: ticketIds.length,
      eventName,
      price: eventPrice,
      totalPrice: eventPrice * ticketIds.length,
      ticketType: ticketType ? { id: ticketType.id, name: ticketType.name } : null,
    });
  } catch (error) {
    console.error('Error creating ticket(s):', error);
    return NextResponse.json(
      { error: 'Failed to create ticket(s)' },
      { status: 500 }
    );
  }
}

// GET /api/tickets - Get all tickets (for admin)
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const eventId = url.searchParams.get('eventId');
    const paginated = url.searchParams.has('page') || url.searchParams.has('pageSize');
    const cursorMode = url.searchParams.has('cursor');
    const cursorParams = parseCursorPagination(url.searchParams);
    const { page, pageSize, skip } = parsePagination(url.searchParams);
    const q = (url.searchParams.get('q') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const session = await getSession();

    if (!session) {
      return apiErrorResponse('Authentication required', 401);
    }

    if (eventId) {
      if (!hasEventAccess(session, eventId)) {
        return apiErrorResponse('You do not have access to this event', 403);
      }
    } else if (session.user.role !== 'ADMIN') {
      return apiErrorResponse('Event ID is required', 400);
    }

    const where: any = {
      ...(eventId ? { eventId } : {}),
      ...(q ? { OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { id: { contains: q, mode: 'insensitive' } },
      ] } : {}),
      ...(status === 'checked_in' ? { checkedIn: true } : status && status !== 'all' ? { status } : {}),
    };
    const [tickets, total] = await Promise.all([prisma.ticket.findMany({
      where,
      include: {
        Event: { select: EVENT_SELECT },
        DeliveryLogs: {
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursorMode ? { take: cursorParams.pageSize + 1, ...(cursorParams.cursor ? { cursor: { id: cursorParams.cursor }, skip: 1 } : {}) } : paginated ? { skip, take: pageSize } : {}),
    }), cursorMode ? Promise.resolve(0) : paginated ? prisma.ticket.count({ where }) : Promise.resolve(0)]);

    const cursorItems = cursorMode ? tickets.slice(0, cursorParams.pageSize) : tickets;
    const nextCursor = cursorMode && tickets.length > cursorParams.pageSize ? tickets[cursorParams.pageSize].id : null;
    const items = cursorItems.map(serializeTicket);
    return NextResponse.json(cursorMode ? { items, pagination: { pageSize: cursorParams.pageSize, nextCursor } } : paginated ? { items, pagination: paginationMeta(page, pageSize, total) } : items);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return apiErrorResponse('Failed to fetch tickets', 500);
  }
}
