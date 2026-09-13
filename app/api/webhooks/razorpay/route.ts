import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { timingSafeStringEqual } from '@/lib/ticket-security';
import { enqueueJob } from '@/lib/job-queue';
import { normalizeRazorpayWebhook, razorpayWebhookKey } from '@/lib/payment-reconciliation';
import { prisma } from '@/lib/prisma';
import { randomUUID } from 'node:crypto';

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature') || '';
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return NextResponse.json({ success: false, error: 'Webhook not configured', code: 'CONFIGURATION_ERROR' }, { status: 503 });
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!signature || !timingSafeStringEqual(expected, signature)) return NextResponse.json({ success: false, error: 'Invalid webhook signature', code: 'AUTHORIZATION_ERROR' }, { status: 401 });
  try {
    const payload = JSON.parse(raw) as Record<string, any>;
    const event = String(payload.event || '');
    if (!['payment.failed', 'payment.captured', 'order.paid'].includes(event)) return NextResponse.json({ success: true, accepted: true });
    const normalized = normalizeRazorpayWebhook(payload);
    const idempotencyKey = razorpayWebhookKey(raw, signature);
    const signatureHash = crypto.createHash('sha256').update(signature).digest('hex');
    const webhook = await prisma.webhookEvent.upsert({
      where: { provider_idempotencyKey: { provider: 'razorpay', idempotencyKey } },
      create: { id: randomUUID(), provider: 'razorpay', idempotencyKey, eventType: event, signatureHash, payload },
      update: {},
    });
    await enqueueJob({
      type: 'razorpay.webhook.reconcile',
      payload: { webhookEventId: webhook.id },
      dedupeKey: `razorpay-webhook:${idempotencyKey}`,
      eventId: null,
      ticketId: null,
      priority: normalized.type === 'payment.captured' ? 10 : 0,
    });
    return NextResponse.json({ success: true, accepted: true, duplicate: webhook.status !== 'received' });
  } catch (error) {
    console.error('Razorpay webhook processing failed', error);
    return NextResponse.json({ success: false, error: 'Invalid webhook payload', code: 'VALIDATION_ERROR' }, { status: 400 });
  }
}
