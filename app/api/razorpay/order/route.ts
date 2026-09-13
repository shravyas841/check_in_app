import { NextRequest, NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { prisma } from '@/lib/prisma';
import { allocatePaidAmount, calculatePromoDiscount, calculateTicketUnitPrice } from '@/lib/pricing';
import { enforceRateLimit } from '@/lib/rate-limit';
import { generateTicketToken } from '@/lib/ticket-security';
import { EVENT_WITH_PRICING_SELECT, EVENT_SELECT } from '@/lib/event-select';
import { sendTicketEmail } from '@/lib/ticket-email';
import { quoteTicketType } from '@/lib/ticket-types';

// Validate Razorpay credentials on startup
const ENV_RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function getRazorpayInstance(keyId?: string, keySecret?: string) {
    const finalKeyId = keyId || ENV_RAZORPAY_KEY_ID;
    const finalKeySecret = keySecret || ENV_RAZORPAY_KEY_SECRET;

    if (!finalKeyId || !finalKeySecret) {
        throw new Error('Razorpay credentials not found');
    }
    return new Razorpay({
        key_id: finalKeyId,
        key_secret: finalKeySecret,
    });
}

function createRequestError(message: string, status = 400) {
    const error = new Error(message) as Error & { status?: number };
    error.status = status;
    return error;
}

async function validatePromoForOrder(
    code: unknown,
    eventId: string,
    quantity: number,
    userEmail?: string | null
) {
    if (typeof code !== 'string' || !code.trim()) return null;

    const promo = await prisma.promoCodeRecord.findUnique({
        where: { code: code.trim().toUpperCase() },
    });

    if (!promo) throw createRequestError('Promo code not found', 404);
    if (!promo.isActive) throw createRequestError('This promo code is no longer active');

    const now = new Date();
    if (now < promo.startsAt) throw createRequestError('This promo code is not yet active');
    if (now > promo.expiresAt) throw createRequestError('This promo code has expired');
    if (promo.usedCount >= promo.maxUses) throw createRequestError('This promo code has reached its usage limit');
    if (promo.eventIds.length > 0 && !promo.eventIds.includes(eventId)) {
        throw createRequestError('This promo code is not valid for this event');
    }
    if (quantity < promo.minTickets) {
        throw createRequestError(`Minimum ${promo.minTickets} ticket(s) required for this promo`);
    }

    if (userEmail && promo.maxUsesPerUser > 0) {
        const userUsages = await prisma.promoUsage.count({
            where: { promoCode: promo.code, userId: userEmail },
        });
        if (userUsages >= promo.maxUsesPerUser) {
            throw createRequestError('You have already used this promo code the maximum number of times');
        }
    }

    return promo;
}

// Create a Razorpay order
export async function POST(request: NextRequest) {
    try {
        const rateLimited = await enforceRateLimit(request, 'razorpay-order', { requests: 10, window: '1 m' });
        if (rateLimited) return rateLimited;

        const body = await request.json();
        const { ticketId, ticketIds, quantity, promoCode } = body;

        const requestedTicketIds = Array.isArray(ticketIds) && ticketIds.length > 0 ? ticketIds : [ticketId];
        if (!requestedTicketIds[0]) {
            return NextResponse.json({ error: 'Ticket ID is required' }, { status: 400 });
        }

        // Check Global Sales Pause
        const siteConfig = await prisma.siteConfig.findUnique({ where: { id: 'default' } });
        const settings = siteConfig?.settings as any;
        if (settings?.globalSalesPaused) {
            return NextResponse.json(
                { error: 'Ticket sales are currently paused globally.' },
                { status: 403 }
            );
        }

        const foundTickets = await prisma.ticket.findMany({
            where: { id: { in: requestedTicketIds } },
            include: { Event: { select: EVENT_WITH_PRICING_SELECT }, TicketType: true },
        });

        if (foundTickets.length !== requestedTicketIds.length) {
            return NextResponse.json({ error: 'One or more tickets were not found' }, { status: 404 });
        }

        const ticketById = new Map(foundTickets.map((ticket) => [ticket.id, ticket]));
        const tickets = requestedTicketIds.map((id) => ticketById.get(id)).filter((ticket): ticket is NonNullable<typeof ticket> => Boolean(ticket));
        const primaryTicket = tickets[0];
        if (!primaryTicket?.Event) {
            return NextResponse.json({ error: 'Event not found for ticket' }, { status: 404 });
        }

        const eventId = primaryTicket.eventId;
        const invalidTicket = tickets.find((ticket) => ticket.eventId !== eventId);
        if (invalidTicket) {
            return NextResponse.json({ error: 'All tickets in an order must belong to the same event' }, { status: 400 });
        }
        if (tickets.some((ticket) => ticket.ticketTypeId !== primaryTicket.ticketTypeId)) {
            return NextResponse.json({ error: 'All tickets in an order must use the same ticket type' }, { status: 400 });
        }

        const nonPendingTicket = tickets.find((ticket) => ticket.status !== 'pending');
        if (nonPendingTicket) {
            return NextResponse.json({ error: 'Only pending tickets can be paid' }, { status: 400 });
        }

        if (primaryTicket.Event.publicationStatus !== 'published') {
            return NextResponse.json({ error: 'This event is not publicly available yet.' }, { status: 404 });
        }
        if (!primaryTicket.Event.isActive) {
            return NextResponse.json(
                { error: 'Ticket sales are paused for this event.' },
                { status: 403 }
            );
        }

        const paidTicketCount = await prisma.ticket.count({
            where: { eventId, status: { in: ['paid', 'partially_refunded'] } },
        });
        if (paidTicketCount + requestedTicketIds.length > primaryTicket.Event.capacity) {
            return NextResponse.json({ error: 'Not enough tickets are available for this event' }, { status: 409 });
        }

        const ticketCount = requestedTicketIds.length;
        if (ticketCount < 1 || ticketCount > 10) {
            return NextResponse.json({ error: 'You can pay for between 1 and 10 tickets per order' }, { status: 400 });
        }

        const requestedQuantity = quantity ? Number(quantity) : ticketCount;
        if (requestedQuantity !== ticketCount) {
            return NextResponse.json({ error: 'Ticket quantity mismatch' }, { status: 400 });
        }

        if (primaryTicket.TicketType) {
            try { quoteTicketType(primaryTicket.TicketType, ticketCount, Math.max(0, primaryTicket.Event.capacity - paidTicketCount)); }
            catch (reason) { return NextResponse.json({ error: reason instanceof Error ? reason.message : 'Ticket type is unavailable' }, { status: 409 }); }
        }
        const unitPrice = primaryTicket.TicketType?.price ?? calculateTicketUnitPrice(primaryTicket.Event as any);
        const subtotal = unitPrice * ticketCount;
        const promo = await validatePromoForOrder(promoCode, eventId, ticketCount, primaryTicket.email);
        const discountAmount = calculatePromoDiscount(subtotal, promo);
        const orderAmount = subtotal - discountAmount;
        if (orderAmount < 0) {
            return NextResponse.json({ error: 'Invalid order amount' }, { status: 400 });
        }

        if (orderAmount === 0) {
            const freeOrderId = `free_${crypto.randomUUID()}`;
            const updatedTickets = await prisma.$transaction(async (tx) => {
                const paidNow: typeof tickets = [];

                for (let index = 0; index < tickets.length; index++) {
                    const ticket = tickets[index];
                    const updateResult = await tx.ticket.updateMany({
                        where: { id: ticket.id, status: 'pending' },
                        data: {
                            status: 'paid',
                            razorpayOrderId: freeOrderId,
                            amountPaid: 0,
                            grossAmount: unitPrice,
                            discountAmount: allocatePaidAmount(discountAmount, ticketCount, index),
                            refundedAmount: 0,
                            paymentMethod: subtotal > 0 ? 'promo' : 'free',
                            promoCodeId: promo?.code || null,
                            token: ticket.token || generateTicketToken(ticket.id),
                        },
                    });

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

                    if (primaryTicket.ticketTypeId) {
                        const type = await tx.ticketType.findUnique({ where: { id: primaryTicket.ticketTypeId }, select: { capacity: true } });
                        const typeUpdate = await tx.ticketType.updateMany({
                            where: { id: primaryTicket.ticketTypeId, active: true, soldCount: { lte: (type?.capacity ?? 0) - paidNow.length } },
                            data: { soldCount: { increment: paidNow.length } },
                        });
                        if (typeUpdate.count !== 1) throw createRequestError('This ticket type is sold out', 409);
                    }

                    if (promo) {
                        const promoUpdate = await tx.promoCodeRecord.updateMany({
                            where: {
                                code: promo.code,
                                isActive: true,
                                startsAt: { lte: new Date() },
                                expiresAt: { gte: new Date() },
                                usedCount: { lte: promo.maxUses - paidNow.length },
                            },
                            data: { usedCount: { increment: paidNow.length } },
                        });
                        if (promoUpdate.count !== 1) {
                            throw createRequestError('This promo code is no longer available', 409);
                        }

                        await tx.promoUsage.createMany({
                            data: paidNow.map((ticket, index) => ({
                                promoCode: promo.code,
                                ticketId: ticket.id,
                                userId: ticket.email || ticket.userId || null,
                                eventId: ticket.eventId,
                                discount: allocatePaidAmount(discountAmount, paidNow.length, index),
                            })),
                        });
                    }
                }

                return tx.ticket.findMany({
                    where: { id: { in: requestedTicketIds } },
                    include: { Event: { select: EVENT_SELECT } },
                    orderBy: { createdAt: 'asc' },
                });
            });

            const updatedTicketById = new Map(updatedTickets.map((ticket) => [ticket.id, ticket]));
            const primaryUpdatedTicket = updatedTicketById.get(primaryTicket.id) || updatedTickets[0];
            const primaryToken = primaryUpdatedTicket?.token || generateTicketToken(primaryTicket.id);
            const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

            // Promo/free orders do not go through Razorpay verification, so
            // deliver their tickets here just like paid orders do.
            const emailResults = await Promise.all(updatedTickets.map(async (ticket) => {
                if (!ticket.email || !ticket.Event) return null;
                try {
                    const result = await sendTicketEmail({
                        to: ticket.email,
                        ticketId: ticket.id,
                        token: ticket.token || generateTicketToken(ticket.id),
                        eventName: ticket.Event.name,
                        attendeeName: ticket.name,
                        eventDate: ticket.Event.date.toISOString(),
                        venue: ticket.Event.venue || 'TBA',
                        amountPaid: ticket.amountPaid,
                        transactionId: 'N/A',
                        orderId: freeOrderId,
                        paymentMode: promo ? 'Promo Code' : 'Free Registration',
                    });
                    await prisma.ticketDeliveryLog.create({
                        data: {
                            ticketId: ticket.id,
                            channel: 'email',
                            recipient: ticket.email,
                            success: Boolean(result.success),
                            error: 'error' in result ? result.error : null,
                        },
                    });
                    return result;
                } catch (error: any) {
                    return { success: false, error: error?.message || 'Ticket email failed' };
                }
            }));

            return NextResponse.json({
                freeOrder: true,
                orderId: freeOrderId,
                amount: 0,
                currency: 'INR',
                ticketId: primaryTicket.id,
                ticketIds: requestedTicketIds,
                token: primaryToken,
                ticketUrl: `${baseUrl}/ticket/${primaryTicket.id}?success=true&token=${encodeURIComponent(primaryToken)}`,
                quantity: ticketCount,
                unitPrice,
                subtotal,
                discountAmount,
                emailSent: emailResults.some((result) => result?.success === true),
            });
        }

        // Fetch Dynamic Config
        const razorpayKeyId = ENV_RAZORPAY_KEY_ID;

        // Create Razorpay order with the correct total amount
        // We use env vars directly now, removing the db-switch logic
        const razorpay = getRazorpayInstance();
        const order = await razorpay.orders.create({
            amount: orderAmount,
            currency: 'INR',
            receipt: primaryTicket.id,
            notes: {
                ticketId: primaryTicket.id,
                ticketIds: requestedTicketIds.join(','),
                quantity: ticketCount,
                eventId,
                unitPrice,
                subtotal,
                discountAmount,
                promoCode: promo?.code || '',
            },
        });

        await prisma.$transaction(
            tickets.map((ticket, index) => prisma.ticket.update({
                where: { id: ticket.id },
                data: {
                    razorpayOrderId: order.id,
                    promoCodeId: promo?.code || null,
                    grossAmount: unitPrice,
                    discountAmount: allocatePaidAmount(discountAmount, ticketCount, index),
                },
            }))
        );

        return NextResponse.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || razorpayKeyId,
            quantity: ticketCount,
            unitPrice,
            subtotal,
            discountAmount,
        });
    } catch (error: any) {
        console.error('Razorpay order creation failed:', error);
        if (error?.status) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json(
            { error: 'Failed to create payment order' },
            { status: 500 }
        );
    }
}
