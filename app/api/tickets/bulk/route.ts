import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasEventAccess, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { respond, parseBody, badRequest, forbidden } from '@/lib/api-helpers';
import { z } from 'zod';
import { isPaidLikeStatus } from '@/lib/ticket-lifecycle';
import { sendTransactionalEmail, isEmailConfigured } from '@/lib/email';
import { generateTicketPDF } from '@/lib/pdf-generator';
import { generateQRCodeBase64 } from '@/lib/qr-generator';
import { EVENT_SELECT } from '@/lib/event-select';
import { generateAuditChecksum } from '@/lib/qr-security';
import { manualCheckInAllowed } from '@/lib/checkin-policy';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
    ticketIds: z.array(z.string().min(1)).min(1).max(500),
    action: z.enum(['resend', 'cancel', 'check_in']),
    reason: z.string().max(500).optional(),
});

/**
 * POST /api/tickets/bulk
 *
 * Apply the same action to many tickets. Organizer/admin only, scoped
 * to events the session can manage. Returns per-ticket success/failure
 * so the UI can show what happened.
 */
export const POST = respond(
    async (req: NextRequest) => {
        const body = await parseBody(req, BodySchema);
        const { ticketIds, action, reason } = body;

        const session = await getSession();
        if (!session) {
            throw forbidden('Authentication required');
        }
        if (!hasRole(session.user.role, ORGANIZER_ROLES)) {
            throw forbidden('Organizer role required');
        }

        const tickets = await prisma.ticket.findMany({
            where: { id: { in: ticketIds } },
            include: { Event: { select: EVENT_SELECT } },
        });

        const config = action === 'check_in'
            ? await prisma.siteConfig.findUnique({ where: { id: 'default' }, select: { settings: true } })
            : null;

        if (tickets.length === 0) {
            throw badRequest('No tickets found');
        }

        // Ensure caller can manage every event referenced by these tickets.
        const eventIds = new Set(tickets.map((t) => t.eventId));
        for (const eid of eventIds) {
            if (!hasEventAccess(session, eid)) {
                throw forbidden('You do not have access to one or more of these events');
            }
        }

        const results: Array<{ id: string; ok: boolean; error?: string }> = [];

        for (const t of tickets) {
            try {
                if (action === 'resend') {
                    if (!t.email) {
                        results.push({ id: t.id, ok: false, error: 'No email on file' });
                        continue;
                    }
                    if (!isPaidLikeStatus(t.status)) {
                        results.push({ id: t.id, ok: false, error: 'Ticket is not paid' });
                        continue;
                    }
                    if (!isEmailConfigured()) {
                        results.push({ id: t.id, ok: false, error: 'Email not configured' });
                        continue;
                    }

                    // Generate PDF + QR, send email, log delivery. Keep it best-effort
                    // per ticket so one failure doesn't block the rest.
                    try {
                        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
                        const qrPayload = JSON.stringify({ ticketId: t.id, token: t.token });
                        const qrCode = await generateQRCodeBase64(qrPayload);
                        const pdfBase64 = await generateTicketPDF({
                            ticketId: t.id,
                            token: t.token || '',
                            attendeeName: t.name,
                            eventName: t.Event?.name || 'Event',
                            eventDate: t.Event?.date ? new Date(t.Event.date).toLocaleDateString() : '',
                            venue: t.Event?.venue || '',
                            amountPaid: 0,
                            transactionId: '',
                            orderId: '',
                            paymentDate: '',
                            qrCode,
                        } as any).catch(() => null);

                        const ticketUrl = `${baseUrl}/ticket/${t.id}${t.token ? `?token=${encodeURIComponent(t.token)}` : ''}`;
                        await sendTransactionalEmail({
                            to: t.email,
                            subject: `Your ticket for ${t.Event?.name || 'the event'}`,
                            htmlContent: `<p>Hi ${t.name},</p><p>Here is your ticket for <b>${t.Event?.name || 'the event'}</b>. View it here: <a href="${ticketUrl}">${ticketUrl}</a></p>`,
                            textContent: `Hi ${t.name}, view your ticket: ${ticketUrl}`,
                            attachments: pdfBase64
                                ? [
                                    {
                                        filename: `ticket-${t.id.slice(-8)}.pdf`,
                                        content: pdfBase64,
                                    },
                                ]
                                : undefined,
                        });

                        await prisma.ticketDeliveryLog.create({
                            data: {
                                ticketId: t.id,
                                channel: 'email',
                                recipient: t.email,
                                success: true,
                            },
                        });

                        results.push({ id: t.id, ok: true });
                    } catch (err) {
                        await prisma.ticketDeliveryLog.create({
                            data: {
                                ticketId: t.id,
                                channel: 'email',
                                recipient: t.email,
                                success: false,
                                error: String((err as Error).message || err).slice(0, 500),
                            },
                        });
                        results.push({ id: t.id, ok: false, error: (err as Error).message || 'Send failed' });
                    }
                } else if (action === 'cancel') {
                    if (t.status !== 'pending') {
                        results.push({ id: t.id, ok: false, error: 'Only pending tickets can be cancelled' });
                        continue;
                    }
                    await prisma.ticket.update({
                        where: { id: t.id },
                        data: { status: 'cancelled' },
                    });
                    results.push({ id: t.id, ok: true });
                } else if (action === 'check_in') {
                    if (t.checkedIn) {
                        results.push({ id: t.id, ok: false, error: 'Already checked in' });
                        continue;
                    }
                    if (!isPaidLikeStatus(t.status)) {
                        results.push({ id: t.id, ok: false, error: 'Ticket is not paid' });
                        continue;
                    }
                    if (!manualCheckInAllowed(config?.settings, t.eventId, session.user.role)) {
                        results.push({ id: t.id, ok: false, error: 'Manual check-in is not approved for this event' });
                        continue;
                    }
                    const checkedInAt = new Date();
                    const updated = await prisma.$transaction(async (tx) => {
                        const result = await tx.ticket.updateMany({
                            where: { id: t.id, checkedIn: false, status: { in: ['paid', 'partially_refunded'] } },
                            data: { checkedIn: true, checkedInAt, checkedInBy: session.user.id },
                        });
                        if (result.count !== 1) return false;
                        await tx.checkInLog.create({
                            data: {
                                ticketId: t.id,
                                eventId: t.eventId,
                                action: 'manual_checkin',
                                performedBy: session.user.id,
                                performedRole: session.user.role,
                                checksum: generateAuditChecksum(t.id, 'manual_checkin', checkedInAt.toISOString(), session.user.id),
                                createdAt: checkedInAt,
                            },
                        });
                        return true;
                    });
                    if (!updated) {
                        results.push({ id: t.id, ok: false, error: 'Already checked in' });
                        continue;
                    }
                    results.push({ id: t.id, ok: true });
                }
            } catch (err) {
                results.push({ id: t.id, ok: false, error: (err as Error).message || 'Failed' });
            }
        }

        const okCount = results.filter((r) => r.ok).length;
        return NextResponse.json({
            action,
            total: results.length,
            succeeded: okCount,
            failed: results.length - okCount,
            results,
        });
    },
    { auth: 'organizer' },
);
