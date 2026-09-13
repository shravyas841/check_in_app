import crypto from 'crypto';

export interface NormalizedRazorpayWebhook {
  type: string;
  paymentId: string | null;
  orderId: string | null;
  status: string | null;
  amount: number | null;
}

export function razorpayWebhookKey(rawBody: string, signature: string) {
  return crypto.createHash('sha256').update(`${signature}:${rawBody}`).digest('hex');
}

export function normalizeRazorpayWebhook(payload: unknown): NormalizedRazorpayWebhook {
  const body = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const payment = body.payload?.payment?.entity || {};
  const order = body.payload?.order?.entity || {};
  return {
    type: typeof body.event === 'string' ? body.event : '',
    paymentId: typeof payment.id === 'string' ? payment.id : null,
    orderId: typeof payment.order_id === 'string' ? payment.order_id : typeof order.id === 'string' ? order.id : null,
    status: typeof payment.status === 'string' ? payment.status : typeof order.status === 'string' ? order.status : null,
    amount: Number.isSafeInteger(payment.amount) ? payment.amount : Number.isSafeInteger(order.amount_paid) ? order.amount_paid : null,
  };
}
