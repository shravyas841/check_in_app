import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { badRequest, parseBody, respond } from '@/lib/api-helpers';

const ticketTypeSchema = z.object({
  id: z.string().uuid().optional(), eventId: z.string().min(1), name: z.string().min(1).max(100),
  description: z.string().max(500).optional(), price: z.number().int().min(0), capacity: z.number().int().min(1),
  salesStart: z.coerce.date().nullable().optional(), salesEnd: z.coerce.date().nullable().optional(),
  minPerOrder: z.number().int().min(1).max(10).default(1), maxPerOrder: z.number().int().min(1).max(10).default(10),
  active: z.boolean().default(true), sortOrder: z.number().int().min(0).default(0),
}).refine((value) => value.maxPerOrder >= value.minPerOrder, { message: 'Maximum per order must be at least the minimum', path: ['maxPerOrder'] })
  .refine((value) => !value.salesStart || !value.salesEnd || value.salesEnd > value.salesStart, { message: 'Sales end must be after sales start', path: ['salesEnd'] });

export const GET = respond(async (request: NextRequest) => {
  const eventId = request.nextUrl.searchParams.get('eventId'); if (!eventId) throw badRequest('Event ID is required');
  const items = await prisma.ticketType.findMany({ where: { eventId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  return NextResponse.json({ success: true, items });
}, { auth: 'admin' });

export const POST = respond(async (request: NextRequest) => {
  const body = await parseBody(request, ticketTypeSchema);
  const item = await prisma.ticketType.create({ data: { id: randomUUID(), ...body } });
  return NextResponse.json({ success: true, item }, { status: 201 });
}, { auth: 'admin' });

export const PATCH = respond(async (request: NextRequest) => {
  const body = await parseBody(request, ticketTypeSchema); if (!body.id) throw badRequest('Ticket type ID is required');
  const existing = await prisma.ticketType.findUnique({ where: { id: body.id } }); if (!existing) throw badRequest('Ticket type not found');
  if (body.capacity < existing.soldCount) throw badRequest('Capacity cannot be lower than tickets already sold');
  const { id, ...data } = body;
  const item = await prisma.ticketType.update({ where: { id }, data });
  return NextResponse.json({ success: true, item });
}, { auth: 'admin' });
