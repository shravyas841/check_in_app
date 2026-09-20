import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasEventAccess, getSession, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { respond, notFound, forbidden } from '@/lib/api-helpers';
import { logAudit } from '@/lib/logger';

export const POST = respond(
    async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        const { id } = await params;
        const session = await getSession();
        if (!hasRole(session?.user.role, ORGANIZER_ROLES) || !hasEventAccess(session, id)) throw forbidden();

        const source = await prisma.event.findUnique({ where: { id } });
        if (!source) throw notFound('Event not found');

        // Build a deep copy of source JSON fields and reset soldCount/isActive.
        const data: Prisma.EventUncheckedCreateInput = {
            id: crypto.randomUUID(),
            name: `${source.name} (Copy)`,
            description: source.description,
            date: source.date,
            startTime: source.startTime,
            endTime: source.endTime,
            venue: source.venue,
            address: source.address,
            price: source.price,
            entryFee: source.entryFee,
            prizePool: source.prizePool,
            category: source.category,
            imageUrl: source.imageUrl,
            capacity: source.capacity,
            soldCount: 0,
            isActive: false,
            publicationStatus: 'draft',
            publishApprovedBy: null,
            publishApprovedAt: null,
            timezone: source.timezone,
            isFeatured: source.isFeatured,
            schedule: (source.schedule ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            speakers: (source.speakers ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            sponsors: (source.sponsors ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            tags: source.tags,
            organizer: source.organizer,
            organizerId: source.organizerId,
            contactEmail: source.contactEmail,
            contactPhone: source.contactPhone,
            termsAndConditions: source.termsAndConditions,
            registrationDeadline: source.registrationDeadline,
            earlyBirdEnabled: source.earlyBirdEnabled,
            earlyBirdPrice: source.earlyBirdPrice,
            earlyBirdDeadline: source.earlyBirdDeadline,
            sendReminders: source.sendReminders,
            registrationFields: (source.registrationFields ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            organizerVideoLink: source.organizerVideoLink,
            videoLink: source.videoLink,
        };

        const copy = await prisma.event.create({ data });

        await logAudit({
            action: 'CREATE',
            resource: 'EVENT',
            resourceId: copy.id,
            details: { duplicatedFrom: source.id, eventName: copy.name },
            userId: session!.user.id,
            userName: session!.user.name || session!.user.email,
            userRole: session!.user.role,
        });

        return NextResponse.json(copy);
    },
);
