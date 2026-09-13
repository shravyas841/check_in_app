import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { badRequest, parseBody, respond } from '@/lib/api-helpers';
import { parsePagination, paginationMeta } from '@/lib/pagination';

const actionSchema = z.object({ id: z.string().uuid(), action: z.enum(['retry', 'dismiss']) });

export const GET = respond(async (request: NextRequest) => {
  const { page, pageSize, skip } = parsePagination(request.nextUrl.searchParams);
  const status = request.nextUrl.searchParams.get('status');
  const where = status && status !== 'all' ? { status } : {};
  const [items, total, counts] = await Promise.all([
    prisma.backgroundJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.backgroundJob.count({ where }),
    prisma.backgroundJob.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  return NextResponse.json({ success: true, items, counts, pagination: paginationMeta(page, pageSize, total) });
}, { auth: 'admin' });

export const POST = respond(async (request: NextRequest) => {
  const body = await parseBody(request, actionSchema);
  const existing = await prisma.backgroundJob.findUnique({ where: { id: body.id } });
  if (!existing) throw badRequest('Background job not found');
  const job = await prisma.backgroundJob.update({
    where: { id: body.id },
    data: body.action === 'retry'
      ? { status: 'pending', nextAttemptAt: new Date(), lockedAt: null, lockedBy: null, dismissedAt: null, lastError: null }
      : { status: 'dismissed', dismissedAt: new Date(), lockedAt: null, lockedBy: null },
  });
  return NextResponse.json({ success: true, job });
}, { auth: 'admin' });
