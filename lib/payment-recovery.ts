import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { enqueueJob } from '@/lib/job-queue';

export async function enqueuePaymentRecovery(input: {
  operation: string; orderId?: string | null; paymentId?: string | null; ticketId?: string | null; eventId?: string | null; payload: Record<string, unknown>; error: unknown;
}) {
  try {
    const legacy = await prisma.paymentRecoveryJob.create({ data: {
      operation: input.operation, orderId: input.orderId || null, paymentId: input.paymentId || null,
      ticketId: input.ticketId || null, eventId: input.eventId || null, payload: input.payload as Prisma.InputJsonValue,
      status: 'pending', lastError: input.error instanceof Error ? input.error.message : String(input.error),
    } });
    await enqueueJob({
      type: 'payment.recovery',
      payload: { legacyJobId: legacy.id, operation: input.operation, orderId: input.orderId || null, paymentId: input.paymentId || null, ticketId: input.ticketId || null, eventId: input.eventId || null, ...input.payload },
      eventId: input.eventId,
      ticketId: input.ticketId,
      dedupeKey: `payment-recovery:${input.operation}:${input.orderId || 'none'}:${input.paymentId || 'none'}`,
      priority: 20,
    });
    return legacy;
  } catch (queueError) {
    console.error('Failed to persist payment recovery job', queueError);
    return null;
  }
}
