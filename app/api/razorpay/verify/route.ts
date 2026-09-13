import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rate-limit';
import Razorpay from 'razorpay';
import { allocatePaidAmount, calculateTicketUnitPrice } from '@/lib/pricing';
import { generateTicketToken, timingSafeStringEqual } from '@/lib/ticket-security';
import { isPaidLikeStatus } from '@/lib/ticket-lifecycle';
import { logSecurityEvent } from '@/lib/security-events';
import { EVENT_WITH_PRICING_SELECT, EVENT_SELECT } from '@/lib/event-select';
import { enqueuePaymentRecovery } from '@/lib/payment-recovery';

function createRequestError(message: string, status = 400) {
    const error = new Error(message) as Error & { status?: number };
    error.status = status;
    return error;
}

// Verify Razorpay payment
export async function POST(request: NextRequest) {
    let gatewayConfirmed = false;
    let recoveryContext: { orderId?: string; paymentId?: string; ticketId?: string; eventId?: string } = {};
    let recoverySignature = '';
    try {
        const rateLimited = await enforceRateLimit(request, 'razorpay-verify', { requests: 10, window: '1 m' });
        if (rateLimited) return rateLimited;

        const body = await request.json();
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, ticketId, emailStyles } = body;
        recoveryContext = { orderId: razorpay_order_id, paymentId: razorpay_payment_id, ticketId };
        recoverySignature = razorpay_signature;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !ticketId) {
            return NextResponse.json({ error: 'Missing payment verification details' }, { status: 400 });
        }

        // Verify signature
        const secret = process.env.RAZORPAY_KEY_SECRET;
        if (!secret) {
            console.error('RAZORPAY_KEY_SECRET not configured');
            return NextResponse.json({ error: 'Payment verification not configured' }, { status: 500 });
        }
        const text = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(text)
            .digest('hex');

        if (!timingSafeStringEqual(expectedSignature, razorpay_signature)) {
            console.error('Invalid payment signature');
            await logSecurityEvent(request, {
                type: 'payment_failed',
                key: `razorpay:${razorpay_order_id || 'missing-order'}`,
                ticketId: ticketId || null,
                details: { reason: 'invalid_signature', razorpay_order_id, razorpay_payment_id },
            });
            return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 });
        }

        const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
        if (!razorpayKeyId || !secret) {
            return NextResponse.json({ error: 'Payment verification not configured' }, { status: 500 });
        }

        const razorpay = new Razorpay({
            key_id: razorpayKeyId,
            key_secret: secret,
        });

        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        if (!payment || payment.order_id !== razorpay_order_id || !['authorized', 'captured'].includes(payment.status || '')) {
            await logSecurityEvent(request, {
                type: 'payment_failed',
                key: `razorpay:${razorpay_order_id || 'missing-order'}`,
                ticketId: ticketId || null,
                details: { reason: 'gateway_status_mismatch', status: payment?.status, payment_order_id: payment?.order_id },
            });
            return NextResponse.json({ error: 'Payment could not be verified with Razorpay' }, { status: 400 });
        }
        gatewayConfirmed = true;

        const paidTotal = Number(payment.amount || 0);
        if (!Number.isFinite(paidTotal) || paidTotal <= 0) {
            return NextResponse.json({ error: 'Invalid paid amount' }, { status: 400 });
        }

        const orderTickets = await prisma.ticket.findMany({
            where: { razorpayOrderId: razorpay_order_id },
            include: { Event: { select: EVENT_WITH_PRICING_SELECT }, TicketType: true },
            orderBy: { createdAt: 'asc' },
        });

        if (orderTickets.length === 0) {
            return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
        }

        if (!orderTickets.some((ticket) => ticket.id === ticketId)) {
            return NextResponse.json({ error: 'Order does not match ticket' }, { status: 400 });
        }

        const eventId = orderTickets[0].eventId;
        recoveryContext.eventId = eventId;
        if (orderTickets.some((ticket) => ticket.eventId !== eventId)) {
            return NextResponse.json({ error: 'Order contains tickets from multiple events' }, { status: 400 });
        }

        const invalidTicket = orderTickets.find((ticket) => !['pending', 'paid', 'partially_refunded'].includes(ticket.status));
        if (invalidTicket) {
            return NextResponse.json({ error: 'Order contains a ticket that cannot be marked as paid' }, { status: 400 });
        }

        const hasFrozenFinancials = orderTickets.every((ticket) => (ticket.grossAmount || 0) > 0);
        if (hasFrozenFinancials) {
            const expectedPaidTotal = orderTickets.reduce((sum, ticket) => (
                sum + Math.max(0, (ticket.grossAmount || 0) - (ticket.discountAmount || 0))
            ), 0);
            if (expectedPaidTotal !== paidTotal) {
                await logSecurityEvent(request, {
                    type: 'payment_failed',
                    key: `razorpay:${razorpay_order_id}`,
                    ticketId,
                    eventId,
                    details: { reason: 'amount_mismatch', expectedPaidTotal, paidTotal },
                });
                return NextResponse.json({ error: 'Payment amount does not match this order' }, { status: 400 });
            }
        }

        const paymentResult = await prisma.$transaction(async (tx) => {
            const updated: any[] = [];
            const paidNow: typeof orderTickets = [];
            const estimatedSubtotal = orderTickets.reduce((sum, ticket) => (
                sum + (ticket.grossAmount || ticket.TicketType?.price || calculateTicketUnitPrice(ticket.Event as any, ticket.createdAt))
            ), 0);
            const totalDiscount = Math.max(0, estimatedSubtotal - paidTotal);

            for (let index = 0; index < orderTickets.length; index++) {
                const ticket = orderTickets[index];
                if (isPaidLikeStatus(ticket.status)) {
                    updated.push(await tx.ticket.update({
                        where: { id: ticket.id },
                        data: {
                            razorpayPaymentId: ticket.razorpayPaymentId || razorpay_payment_id,
                            razorpayOrderId: ticket.razorpayOrderId || razorpay_order_id,
                            paymentMethod: ticket.paymentMethod || 'razorpay',
                            token: ticket.token || generateTicketToken(ticket.id),
                        },
                        include: { Event: { select: EVENT_SELECT } },
                    }));
                    continue;
                }

                const grossAmount = ticket.grossAmount || ticket.TicketType?.price || calculateTicketUnitPrice(ticket.Event as any, ticket.createdAt);
                const discountAmount = ticket.discountAmount || allocatePaidAmount(totalDiscount, orderTickets.length, index);
                const updateResult = await tx.ticket.updateMany({
                    where: { id: ticket.id, status: 'pending' },
                    data: {
                        status: 'paid',
                        razorpayPaymentId: razorpay_payment_id,
                        razorpayOrderId: razorpay_order_id,
                        amountPaid: allocatePaidAmount(paidTotal, orderTickets.length, index),
                        grossAmount,
                        discountAmount,
                        refundedAmount: 0,
                        paymentMethod: 'razorpay',
                        token: ticket.token || generateTicketToken(ticket.id),
                    },
                });

                const updatedTicket = await tx.ticket.findUnique({
                    where: { id: ticket.id },
                    include: { Event: { select: EVENT_SELECT } },
                });
                if (!updatedTicket) throw createRequestError('Ticket not found', 404);
                updated.push(updatedTicket);
                if (updateResult.count === 1) paidNow.push(ticket);
            }

            if (paidNow.length > 0) {
                const currentEvent = await tx.event.findUnique({
                    where: { id: eventId },
                    select: { capacity: true },
                });

                const capacityUpdate = await tx.event.updateMany({
                    where: {
                        id: eventId,
                        soldCount: { lte: (currentEvent?.capacity ?? 0) - paidNow.length },
                    },
                    data: { soldCount: { increment: paidNow.length } },
                });

                if (capacityUpdate.count !== 1) {
                    throw createRequestError('Not enough tickets are available for this event', 409);
                }

                const typeCounts = paidNow.reduce<Map<string, number>>((counts, ticket) => {
                    if (ticket.ticketTypeId) counts.set(ticket.ticketTypeId, (counts.get(ticket.ticketTypeId) || 0) + 1);
                    return counts;
                }, new Map());
                for (const [ticketTypeId, count] of typeCounts) {
                    const type = await tx.ticketType.findUnique({ where: { id: ticketTypeId }, select: { capacity: true } });
                    const typeUpdate = await tx.ticketType.updateMany({ where: { id: ticketTypeId, active: true, soldCount: { lte: (type?.capacity ?? 0) - count } }, data: { soldCount: { increment: count } } });
                    if (typeUpdate.count !== 1) throw createRequestError('This ticket type is sold out', 409);
                }

                const promoGroups = paidNow.reduce<Record<string, typeof paidNow>>((groups, ticket) => {
                    if (!ticket.promoCodeId) return groups;
                    groups[ticket.promoCodeId] = [...(groups[ticket.promoCodeId] || []), ticket];
                    return groups;
                }, {});

                for (const [promoCode, tickets] of Object.entries(promoGroups)) {
                    const promoRecord = await tx.promoCodeRecord.findUnique({ where: { code: promoCode } });
                    const now = new Date();
                    if (!promoRecord || !promoRecord.isActive || promoRecord.startsAt > now || promoRecord.expiresAt < now) {
                        throw createRequestError('This promo code is no longer available', 409);
                    }
                    const promoUpdate = await tx.promoCodeRecord.updateMany({
                        where: { code: promoCode, usedCount: { lte: promoRecord.maxUses - tickets.length } },
                        data: { usedCount: { increment: tickets.length } },
                    });
                    if (promoUpdate.count !== 1) {
                        throw createRequestError('This promo code usage limit was reached', 409);
                    }

                    await tx.promoUsage.createMany({
                        data: tickets.map((ticket, index) => ({
                            promoCode,
                            ticketId: ticket.id,
                            userId: ticket.email || ticket.userId || null,
                            eventId: ticket.eventId,
                            discount: ticket.discountAmount || allocatePaidAmount(totalDiscount, paidNow.length, index),
                        })),
                    });
                }
            }

            return { updatedTickets: updated, paidNowCount: paidNow.length };
        });

        const { updatedTickets, paidNowCount } = paymentResult;
        const ticketData = updatedTickets.find((ticket) => ticket.id === ticketId) || updatedTickets[0];
        const amountPaid = ticketData.amountPaid || allocatePaidAmount(paidTotal, orderTickets.length, 0);
        const primaryToken = ticketData.token || generateTicketToken(ticketId);
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
        const ticketUrl = `${baseUrl}/ticket/${ticketId}?success=true&token=${encodeURIComponent(primaryToken)}`;

        const recipientEmail = ticketData?.email;
        if (paidNowCount > 0 && recipientEmail && ticketData?.Event) {
            try {
                const { sendTicketEmail } = await import('@/lib/ticket-email');

                const emailResult = await sendTicketEmail({
                    to: recipientEmail,
                    ticketId,
                    token: primaryToken,
                    eventName: ticketData.Event.name,
                    attendeeName: ticketData.name || 'Guest',
                    eventDate: ticketData.Event.date?.toISOString?.() || 'TBA',
                    venue: ticketData.Event.venue || 'TBA',
                    amountPaid,
                    transactionId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    paymentDate: new Date().toISOString(),
                    paymentMode: 'Online Payment',
                    emailStyles,
                });

                if (!emailResult.success) {
                    const emailError = 'error' in emailResult ? emailResult.error : 'message' in emailResult ? emailResult.message : 'Unknown email error';
                    console.warn('Ticket email was not sent:', emailError);
                }
            } catch (emailError) {
                console.warn('Email sending failed:', emailError);
            }
        } else {
            console.warn('Skipping confirmation email because no new paid ticket or recipient email was available');
        }

        return NextResponse.json({
            success: true,
            ticketId: ticketId,
            token: primaryToken,
            ticketUrl,
            alreadyVerified: paidNowCount === 0,
            message: 'Payment verified successfully',
        });
    } catch (error: any) {
        console.error('Payment verification failed:', error);
        if (gatewayConfirmed && request.headers.get('x-recovery-worker') !== '1') {
            await enqueuePaymentRecovery({
                operation: 'payment_verification', ...recoveryContext,
                payload: { orderId: recoveryContext.orderId || null, paymentId: recoveryContext.paymentId || null, ticketId: recoveryContext.ticketId || null, signature: recoverySignature },
                error,
            });
        }
        if (error?.status) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json(
            { error: 'Payment verification failed' },
            { status: 500 }
        );
    }
}
