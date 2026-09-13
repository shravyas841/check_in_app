import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { badRequest, forbidden, parseBody, respond, unauthorized } from '@/lib/api-helpers';
import { getSession, hasEventAccess } from '@/lib/auth';

const shiftSchema = z.object({
  id: z.string().uuid().optional(), eventId: z.string().min(1), userId: z.string().min(1),
  userName: z.string().max(200).optional(), deviceId: z.string().max(200).optional(), zone: z.string().max(100).optional(),
  startsAt: z.coerce.date(), endsAt: z.coerce.date(), status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).default('scheduled'),
}).refine((value) => value.endsAt > value.startsAt, { message: 'Shift end must be after its start', path: ['endsAt'] });

export const GET = respond(async (request: NextRequest) => {
  const session = await getSession(); if (!session) throw unauthorized();
  const eventId = request.nextUrl.searchParams.get('eventId'); if (!eventId) throw badRequest('Event ID is required');
  if (!hasEventAccess(session, eventId)) throw forbidden();
  const items = await prisma.staffShift.findMany({ where: { eventId }, orderBy: { startsAt: 'asc' }, take: 250 });
  return NextResponse.json({ success: true, items });
}, { auth: 'organizer' });

export const POST = respond(async (request: NextRequest) => {
  const session = await getSession(); if (!session) throw unauthorized();
  const body = await parseBody(request, shiftSchema); if (!hasEventAccess(session, body.eventId)) throw forbidden();
  const shift = await prisma.staffShift.create({ data: { id: randomUUID(), ...body, createdBy: session.user.id } });
  return NextResponse.json({ success: true, shift }, { status: 201 });
}, { auth: 'organizer' });

export const PATCH = respond(async (request: NextRequest) => {
  const session = await getSession(); if (!session) throw unauthorized();
  const body = await parseBody(request, shiftSchema); if (!body.id) throw badRequest('Shift ID is required');
  const current = await prisma.staffShift.findUnique({ where: { id: body.id } }); if (!current) throw badRequest('Shift not found');
  if (!hasEventAccess(session, current.eventId) || current.eventId !== body.eventId) throw forbidden();
  const { id, ...data } = body; const shift = await prisma.staffShift.update({ where: { id }, data });
  return NextResponse.json({ success: true, shift });
}, { auth: 'organizer' });
