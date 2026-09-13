import type { BackgroundJob } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizeRazorpayWebhook } from '@/lib/payment-reconciliation';
import { allocatePaidAmount } from '@/lib/pricing';

type JobPayload = Record<string, unknown>;

async function reconcileRazorpayWebhook(job: BackgroundJob) {
  const payload = job.payload as JobPayload;
  const webhookEventId = String(payload.webhookEventId || '');
  if (!webhookEventId) throw new Error('Webhook event ID is missing');
  const webhook = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!webhook || webhook.status === 'processed') return;
  const normalized = normalizeRazorpayWebhook(webhook.payload);
  if (!normalized.orderId) throw new Error('Razorpay order ID is missing');

  if (normalized.type === 'payment.failed') {
    await prisma.$transaction([
      prisma.webhookEvent.update({ where: { id: webhook.id }, data: { status: 'processed', processedAt: new Date(), attempts: { increment: 1 } } }),
      prisma.paymentReconciliationAttempt.create({ data: { webhookEventId: webhook.id, orderId: normalized.orderId, paymentId: normalized.paymentId, outcome: 'provider_failed' } }),
    ]);
    return;
  }

  const tickets = await prisma.ticket.findMany({
    where: { razorpayOrderId: normalized.orderId },
    select: { id: true, eventId: true, status: true, ticketTypeId: true },
  });
  if (!tickets.length) throw new Error('No tickets found for Razorpay order');
  const unpaid = tickets.filter((ticket) => !['paid', 'partially_refunded'].includes(ticket.status));
  const total = normalized.amount || 0;

  await prisma.$transaction(async (tx) => {
    for (const [index, ticket] of unpaid.entries()) {
      const amount = allocatePaidAmount(total, Math.max(1, unpaid.length), index);
      await tx.ticket.update({ where: { id: ticket.id }, data: { status: 'paid', razorpayPaymentId: normalized.paymentId, amountPaid: amount, grossAmount: amount } });
    }
    if (unpaid.length) {
      await tx.event.update({ where: { id: tickets[0].eventId }, data: { soldCount: { increment: unpaid.length } } });
      const byType = new Map<string, number>();
      for (const ticket of unpaid) if (ticket.ticketTypeId) byType.set(ticket.ticketTypeId, (byType.get(ticket.ticketTypeId) || 0) + 1);
      for (const [ticketTypeId, count] of byType) await tx.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: { increment: count } } });
    }
    await tx.webhookEvent.update({ where: { id: webhook.id }, data: { status: 'processed', processedAt: new Date(), attempts: { increment: 1 }, lastError: null } });
    await tx.paymentReconciliationAttempt.create({ data: { webhookEventId: webhook.id, orderId: normalized.orderId, paymentId: normalized.paymentId, outcome: unpaid.length ? 'settled' : 'already_settled' } });
  });
}

export async function handleBackgroundJob(job: BackgroundJob) {
  switch (job.type) {
    case 'razorpay.webhook.reconcile':
      return reconcileRazorpayWebhook(job);
    case 'payment.recovery': {
      const payload = job.payload as JobPayload;
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
      if (!baseUrl || !payload.orderId || !payload.paymentId || !payload.ticketId || !payload.signature) throw new Error('Payment recovery payload is incomplete or base URL is not configured');
      const response = await fetch(new URL('/api/razorpay/verify', baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-recovery-worker': '1' }, body: JSON.stringify({ razorpay_order_id: payload.orderId, razorpay_payment_id: payload.paymentId, razorpay_signature: payload.signature, ticketId: payload.ticketId }) });
      if (!response.ok) throw new Error(`Payment recovery verification failed with ${response.status}`);
      return;
    }
    default:
      throw new Error(`Unsupported background job type: ${job.type}`);
  }
}
