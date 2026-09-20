import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { calculateDynamicPrice } from '@/lib/pricing';
import { getSession, hasEventAccess, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { logAudit } from '@/lib/logger';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        let event;
        try {
            event = await prisma.event.findUnique({
                where: { id },
                include: { PricingRule: true },
            });
        } catch (pricingError) {
            // Prisma client can throw when the database schema diverges from the
            // generated Prisma schema (missing columns, renamed fields, etc.). In
            // that case, fall back to a raw SQL select to avoid returning 404.
            console.warn('Prisma findUnique failed; falling back to raw SQL select.', pricingError);
            try {
                const rows: any = await prisma.$queryRaw`SELECT * FROM "Event" WHERE id = ${id} LIMIT 1`;
                const row = rows && rows[0];
                if (row) {
                    event = { ...row, PricingRule: [] } as any;
                } else {
                    event = null;
                }
            } catch (rawErr) {
                console.error('Raw SQL fallback also failed:', rawErr);
                event = null;
            }
        }

        if (!event) {
            return NextResponse.json({ error: 'Event not found' }, { status: 404 });
        }

        if ((event as any).publicationStatus !== 'published') {
            const session = await getSession();
            if (session?.user.role !== 'ADMIN' && !(session && hasEventAccess(session, id))) {
                return NextResponse.json({ error: 'Event not found' }, { status: 404 });
            }
        }

        // Safely compute currentPrice — pricing logic can throw if data is unexpected.
        let currentPrice = (event as any)?.price ?? 0;
        try {
            currentPrice = calculateDynamicPrice(event as any);
        } catch (calcErr) {
            console.warn('calculateDynamicPrice failed, falling back to base price', calcErr);
            currentPrice = Number((event as any)?.price ?? 0);
        }

        return NextResponse.json({
            ...event,
            currentPrice,
        });
    } catch (error) {
        console.error('Failed to fetch event:', error);
        return NextResponse.json({ error: 'Failed to fetch event' }, { status: 500 });
    }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;

        // Check permissions: Admin can edit any, Organizer can only edit assigned
        if (!hasRole(session.user.role, ORGANIZER_ROLES)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        if (!hasEventAccess(session, id)) {
            return NextResponse.json({ error: 'Forbidden: Not assigned to this event' }, { status: 403 });
        }

        const body = await request.json();

        // STRICT ALLOWLIST: Only allow specific fields to be updated
        // This prevents any relation or immutable field from breaking the update
        const updateData: any = {};

        const organizerFields = [
            'name', 'description', 'startTime', 'endTime', 'venue', 'address',
            'category', 'imageUrl', 'organizer', 'contactEmail', 'contactPhone',
            'termsAndConditions', 'registrationDeadline', 'sendReminders', 'videoLink',
            'organizerVideoLink', 'tags', 'registrationFields', 'schedule',
            'speakers', 'timezone'
        ];
        const adminOnlyFields = ['price', 'entryFee', 'prizePool', 'capacity', 'isActive', 'isFeatured', 'earlyBirdEnabled', 'earlyBirdPrice', 'earlyBirdDeadline', 'sponsors'];
        const allowedFields = session.user.role === 'ADMIN' ? [...organizerFields, ...adminOnlyFields] : organizerFields;

        // Copy only allowed fields
        for (const field of allowedFields) {
            if (body[field] !== undefined) {
                updateData[field] = body[field];
            }
        }

        // Specific type handling
        if (body.date) updateData.date = new Date(body.date);

        // Ensure numeric fields are numbers
        if (updateData.price !== undefined) updateData.price = Number(updateData.price);
        if (updateData.entryFee !== undefined) updateData.entryFee = Number(updateData.entryFee);
        if (updateData.prizePool !== undefined) updateData.prizePool = Number(updateData.prizePool);
        if (updateData.capacity !== undefined) updateData.capacity = Number(updateData.capacity);
        if (updateData.earlyBirdPrice !== undefined) updateData.earlyBirdPrice = Number(updateData.earlyBirdPrice);

        const event = await prisma.event.update({
            where: { id },
            data: updateData,
        });

        // Log event update
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
        console.error('Failed to update event:', error);
        return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
    }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getSession();
        if (!session || session.user.role !== 'ADMIN') {
            return NextResponse.json({ error: 'Forbidden: Admin only' }, { status: 403 });
        }

        const { id } = await params;

        // Get event name before deletion for logging
        const event = await prisma.event.findUnique({ where: { id }, select: { name: true } });

        await prisma.event.delete({ where: { id } });

        // Log event deletion
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
        console.error('Failed to delete event:', error);
        return NextResponse.json({ error: 'Failed to delete event' }, { status: 500 });
    }
}
