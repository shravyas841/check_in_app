import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import { getTicketFinancials, getTicketLifecycleStatus } from '@/lib/ticket-lifecycle';
import { EVENT_SELECT } from '@/lib/event-select';

export const dynamic = 'force-dynamic';

function serializeTicket(ticket: any) {
    const { Event, TicketType, DeliveryLogs, ...t } = ticket;
    const fin = getTicketFinancials(t, TicketType?.price || Event?.price || 0);
    return {
        ...t,
        ...fin,
        lifecycleStatus: getTicketLifecycleStatus(t),
        event: Event,
        ticketType: TicketType,
        deliveryHistory: DeliveryLogs || [],
    };
}

/**
 * GET /api/me/tickets
 *
 * Returns the signed-in user's tickets. We match by userId primarily,
 * and fall back to email so attendees who booked before sign-in still
 * see their tickets once they sign in with the same email.
 */
export async function GET(_req: NextRequest) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }

        const userId = session.user.id;
        const email = session.user.email;

        const tickets = await prisma.ticket.findMany({
            where: {
                OR: [
                    userId ? { userId } : { id: '__none__' },
                    email ? { email } : { id: '__none__' },
                ],
            },
            include: { Event: { select: EVENT_SELECT }, TicketType: true, DeliveryLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
            orderBy: { createdAt: 'desc' },
        });

        return NextResponse.json(tickets.map(serializeTicket));
    } catch (err) {
        console.error('me/tickets error:', err);
        return NextResponse.json({ error: 'Failed to load tickets' }, { status: 500 });
    }
}
