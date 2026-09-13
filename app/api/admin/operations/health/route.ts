import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { respond } from '@/lib/api-helpers';

export const GET = respond(async () => {
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const [pendingJobs, deadLetters, pendingRecoveries, openIncidents] = await Promise.all([
    prisma.backgroundJob.count({ where: { status: 'pending' } }),
    prisma.backgroundJob.count({ where: { status: 'dead_letter' } }),
    prisma.paymentRecoveryJob.count({ where: { status: 'pending' } }),
    prisma.operationalIncident.count({ where: { status: 'open' } }),
  ]);
  const configured = {
    database: Boolean(process.env.POSTGRES_PRISMA_URL),
    cron: Boolean(process.env.CRON_SECRET),
    razorpay: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    razorpayWebhook: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET),
    email: Boolean(process.env.EMAIL_SERVER_HOST || process.env.RESEND_API_KEY),
  };
  const degraded = !configured.cron || !configured.razorpayWebhook || deadLetters > 0;
  return NextResponse.json({
    success: true,
    status: degraded ? 'degraded' : 'healthy',
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    configured,
    queues: { pendingJobs, deadLetters, pendingRecoveries },
    incidents: { open: openIncidents },
  });
}, { auth: 'admin' });
