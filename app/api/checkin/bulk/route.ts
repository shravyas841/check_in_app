import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getSession, hasEventAccess, hasRole, CHECKIN_ROLES } from '@/lib/auth';
import { generateAuditChecksum } from '@/lib/qr-security';
import { isPaidLikeStatus, PAID_LIKE_STATUSES } from '@/lib/ticket-lifecycle';
import { manualCheckInAllowed } from '@/lib/checkin-policy';

export async function POST(request: NextRequest) {
    try {
        const session = await getSession();
        if (!session || !hasRole(session.user.role, CHECKIN_ROLES)) {
            return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
        }

        const rateLimited = await enforceRateLimit(request, 'checkin-bulk', { requests: 20, window: '1 m' }, session.user.id);
        if (rateLimited) return rateLimited;

        const body = await request.json();
        const { ticketIds } = body;

        if (!Array.isArray(ticketIds) || ticketIds.length === 0 || ticketIds.length > 100 || ticketIds.some((id) => typeof id !== 'string' || !id.trim())) {
            return NextResponse.json({ error: 'Ticket IDs must be a non-empty array of at most 100 IDs' }, { status: 400 });
        }

        const config = await prisma.siteConfig.findUnique({ where: { id: 'default' }, select: { settings: true } });

        const results: { ticketId: string; success: boolean; error?: string; name?: string }[] = [];
        for (const ticketId of ticketIds) {
            try {
                const ticket = await prisma.ticket.findUnique({
                    where: { id: ticketId },
                });

                if (!ticket) {
                    results.push({ ticketId, success: false, error: 'Ticket not found' });
                    continue;
                }

                if (!hasEventAccess(session, ticket.eventId)) {
                    results.push({ ticketId, success: false, error: 'No access to this event' });
                    continue;
                }

                if (!isPaidLikeStatus(ticket.status)) {
                    results.push({ ticketId, success: false, error: 'Ticket not paid' });
                    continue;
                }

                if (!manualCheckInAllowed(config?.settings, ticket.eventId, session.user.role)) {
                    results.push({ ticketId, success: false, error: 'Manual check-in is not approved for this event', name: ticket.name });
                    continue;
                }

                if (ticket.checkedIn) {
                    results.push({ ticketId, success: false, error: 'Already checked in', name: ticket.name });
                    continue;
                }

                const timestamp = new Date();
                const updated = await prisma.$transaction(async (tx) => {
                    const updateResult = await tx.ticket.updateMany({
                        where: { id: ticketId, checkedIn: false, status: { in: [...PAID_LIKE_STATUSES] } },
                        data: {
                            checkedIn: true,
                            checkedInAt: timestamp,
                            checkedInBy: session.user.id,
                        },
                    });
                    if (updateResult.count !== 1) return false;
                    await tx.checkInLog.create({
                        data: {
                            ticketId,
                            eventId: ticket.eventId,
                            action: 'manual_checkin',
                            performedBy: session.user.id,
                            performedRole: session.user.role,
                            ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
                            userAgent: request.headers.get('user-agent') || 'unknown',
                            checksum: generateAuditChecksum(ticketId, 'manual_checkin', timestamp.toISOString(), session.user.id),
                            createdAt: timestamp,
                        },
                    });
                    return true;
                });

                if (!updated) {
                    results.push({ ticketId, success: false, error: 'Ticket was checked in by another scanner', name: ticket.name });
                    continue;
                }

                results.push({ ticketId, success: true, name: ticket.name });
            } catch (err: any) {
                results.push({ ticketId, success: false, error: err.message });
            }
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        return NextResponse.json({
            success: true,
            totalProcessed: ticketIds.length,
            successful,
            failed,
            results,
        });
    } catch (error) {
        console.error('Bulk check-in error:', error);
        return NextResponse.json(
            { error: 'Failed to process bulk check-in' },
            { status: 500 }
        );
    }
}
