import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { badRequest, forbidden, parseBody, respond, unauthorized } from '@/lib/api-helpers';
import { getSession, hasEventAccess } from '@/lib/auth';

const incidentSchema = z.object({
  eventId: z.string().min(1).optional(), category: z.string().min(1).max(100),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'), source: z.string().min(1).max(100),
  summary: z.string().min(1).max(500), details: z.record(z.string(), z.unknown()).optional(), fingerprint: z.string().max(300).optional(),
});

export const POST = respond(async (request: NextRequest) => {
  const session = await getSession(); if (!session) throw unauthorized();
  const body = await parseBody(request, incidentSchema);
  if (body.eventId && !hasEventAccess(session, body.eventId)) throw forbidden();
  const data: Prisma.OperationalIncidentUncheckedCreateInput = {
    id: randomUUID(), eventId: body.eventId || null, category: body.category, severity: body.severity,
    source: body.source, summary: body.summary, fingerprint: body.fingerprint || null,
    details: body.details as Prisma.InputJsonValue | undefined,
  };
  const incident = body.fingerprint
    ? await prisma.operationalIncident.upsert({
        where: { fingerprint: body.fingerprint },
        create: data,
        update: { status: 'open', severity: body.severity, summary: body.summary, details: body.details as Prisma.InputJsonValue | undefined, lastSeenAt: new Date(), occurrenceCount: { increment: 1 }, resolvedAt: null },
      })
    : await prisma.operationalIncident.create({ data });
  return NextResponse.json({ success: true, incident }, { status: 201 });
}, { auth: 'organizer' });

export const PATCH = respond(async (request: NextRequest) => {
  const session = await getSession(); if (!session) throw unauthorized();
  const body = await parseBody(request, z.object({ id: z.string().uuid(), status: z.enum(['open', 'resolved']) }));
  const current = await prisma.operationalIncident.findUnique({ where: { id: body.id } }); if (!current) throw badRequest('Incident not found');
  if (current.eventId && !hasEventAccess(session, current.eventId)) throw forbidden();
  const incident = await prisma.operationalIncident.update({ where: { id: body.id }, data: { status: body.status, resolvedAt: body.status === 'resolved' ? new Date() : null } });
  return NextResponse.json({ success: true, incident });
}, { auth: 'organizer' });
