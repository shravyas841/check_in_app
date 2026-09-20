import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { calculateDynamicPrice } from '@/lib/pricing';
import { getSession, hasEventAccess, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { logAudit } from '@/lib/logger';
import { paginationMeta, parsePagination } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const paginated = url.searchParams.has('page') || url.searchParams.has('pageSize');
        const { page, pageSize, skip } = parsePagination(url.searchParams);
        // Use raw SQL here because Prisma can fail when the live database schema
        // drifts from the generated client. Raw reads keep the list endpoint alive.
        const paginationSql = paginated ? Prisma.sql`LIMIT ${pageSize} OFFSET ${skip}` : Prisma.empty;
        const session = await getSession();
        const canViewUnpublished = session?.user.role === 'ADMIN';
        const publicationSql = canViewUnpublished
            ? Prisma.empty
            : Prisma.sql`WHERE "publicationStatus" = 'published'`;
        const events: any[] = await prisma.$queryRaw`
            SELECT *
            FROM "Event"
            ${publicationSql}
            ORDER BY "date" ASC
            ${paginationSql}
        `;
        const totalRows = paginated ? await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint as count FROM "Event"` : [];
        const total = paginated ? Number(totalRows[0]?.count || 0) : 0;

        const eventsWithPrice = events.map(event => {
            const eventForPricing = {
                ...event,
                pricingRules: [],
            };
            return {
                ...event,
                currentPrice: calculateDynamicPrice(eventForPricing as any)
            };
        });

        return NextResponse.json(paginated ? { items: eventsWithPrice, pagination: paginationMeta(page, pageSize, total) } : eventsWithPrice);
    } catch (error) {
        console.error('Failed to fetch events:', error);
        return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Only admins can create events' }, { status: 403 });

        const rest = await request.json();
        delete rest.id;

        // Validate required fields
        if (!rest.name || !rest.date) {
            return NextResponse.json({ error: 'Name and date are required' }, { status: 400 });
        }

        const event = await prisma.event.create({
            data: {
                id: crypto.randomUUID(),
                ...rest,
                organizer: rest.organizer || session.user.name || session.user.email,
                organizerId: session.user.id,
                date: new Date(rest.date),
                publicationStatus: 'draft',
                publishApprovedBy: null,
                publishApprovedAt: null,
            },
        });

        // Validate that event was created with an ID
        if (!event || !event.id) {
            console.error('Event creation returned invalid data:', event);
            return NextResponse.json({ error: 'Failed to create event - invalid response' }, { status: 500 });
        }

        // Log event creation
        await logAudit({
            action: 'CREATE',
            resource: 'EVENT',
            resourceId: event.id,
            details: { eventName: event.name, category: event.category },
            userId: session.user.id,
            userName: session.user.name || session.user.email,
            userRole: session.user.role,
        });

        return NextResponse.json(event);
    } catch (error) {
        console.error('Failed to create event:', error);
        return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (!hasRole(session.user.role, ORGANIZER_ROLES)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { id, ...data } = body;

        if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });
        if (!hasEventAccess(session, id)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const updateData: Record<string, unknown> = {};
        const organizerFields = [
            'name', 'description', 'startTime', 'endTime', 'venue', 'address',
            'category', 'imageUrl', 'organizer', 'contactEmail', 'contactPhone',
            'termsAndConditions', 'registrationDeadline', 'sendReminders', 'videoLink',
            'organizerVideoLink', 'tags', 'registrationFields', 'schedule',
            'speakers', 'timezone'
        ];
        const adminOnlyFields = ['price', 'entryFee', 'prizePool', 'capacity', 'isActive', 'isFeatured', 'earlyBirdEnabled', 'earlyBirdPrice', 'earlyBirdDeadline', 'sponsors'];
        const allowedFields = session.user.role === 'ADMIN' ? [...organizerFields, ...adminOnlyFields] : organizerFields;

        for (const field of allowedFields) {
            if (data[field] !== undefined) {
                updateData[field] = data[field];
            }
        }

        if (data.date) updateData.date = new Date(data.date);
        if (updateData.price !== undefined) updateData.price = Number(updateData.price);
        if (updateData.entryFee !== undefined) updateData.entryFee = Number(updateData.entryFee);
        if (updateData.prizePool !== undefined) updateData.prizePool = Number(updateData.prizePool);
        if (updateData.capacity !== undefined) updateData.capacity = Number(updateData.capacity);
        if (updateData.earlyBirdPrice !== undefined) updateData.earlyBirdPrice = Number(updateData.earlyBirdPrice);

        const event = await prisma.event.update({
            where: { id },
            data: updateData,
        });

        await logAudit({
            action: 'UPDATE',
            resource: 'EVENT',
            resourceId: id,
            details: { eventName: event.name, changes: Object.keys(updateData) },
            userId: session.user.id,
            userName: session.user.name || session.user.email,
            userRole: session.user.role,
        });

        return NextResponse.json(event);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const session = await getSession();
        if (!session || session.user.role !== 'ADMIN') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const url = new URL(request.url);
        const id = url.searchParams.get('id');

        if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });

        const event = await prisma.event.findUnique({ where: { id }, select: { name: true } });
        await prisma.event.delete({ where: { id } });

        await logAudit({
            action: 'DELETE',
            resource: 'EVENT',
            resourceId: id,
            details: { eventName: event?.name },
            userId: session.user.id,
            userName: session.user.name || session.user.email,
            userRole: session.user.role,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
    }
}
