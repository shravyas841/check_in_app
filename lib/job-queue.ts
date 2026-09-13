import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { calculateJobBackoffMs, isStaleJobClaim, nextJobStatus } from '@/lib/background-jobs';

export type EnqueueJobInput = {
  type: string;
  payload: Prisma.InputJsonValue;
  eventId?: string | null;
  ticketId?: string | null;
  dedupeKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  nextAttemptAt?: Date;
};

export async function enqueueJob(input: EnqueueJobInput) {
  if (input.dedupeKey) {
    return prisma.backgroundJob.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: { id: randomUUID(), ...input },
      update: {},
    });
  }
  return prisma.backgroundJob.create({ data: { id: randomUUID(), ...input } });
}

export async function claimNextJob(workerId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.backgroundJob.findFirst({
      where: {
        status: { in: ['pending', 'processing'] },
        nextAttemptAt: { lte: now },
        dismissedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }],
      },
      orderBy: [{ priority: 'desc' }, { nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!candidate) return null;

    const claimed = await tx.backgroundJob.updateMany({
      where: {
        id: candidate.id,
        OR: [{ lockedAt: null }, { lockedAt: candidate.lockedAt }],
      },
      data: { status: 'processing', lockedAt: now, lockedBy: workerId, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    return tx.backgroundJob.findUnique({ where: { id: candidate.id } });
  });
}

export async function completeJob(id: string) {
  return prisma.backgroundJob.update({
    where: { id },
    data: { status: 'completed', completedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
  });
}

export async function failJob(id: string, error: unknown, retryable = true) {
  const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
  const status = nextJobStatus({ attempts: job.attempts, maxAttempts: job.maxAttempts, retryable });
  return prisma.backgroundJob.update({
    where: { id },
    data: {
      status,
      lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      nextAttemptAt: status === 'pending' ? new Date(Date.now() + calculateJobBackoffMs(job.attempts)) : job.nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

export async function recoverStaleClaims(now = new Date()) {
  const processing = await prisma.backgroundJob.findMany({ where: { status: 'processing', lockedAt: { not: null } } });
  const staleIds = processing.filter((job) => isStaleJobClaim(job.lockedAt, now)).map((job) => job.id);
  if (!staleIds.length) return 0;
  const result = await prisma.backgroundJob.updateMany({
    where: { id: { in: staleIds }, status: 'processing' },
    data: { status: 'pending', lockedAt: null, lockedBy: null, lastError: 'Recovered stale worker claim', nextAttemptAt: now },
  });
  return result.count;
}
