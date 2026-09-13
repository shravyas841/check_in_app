import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getTicketTypeAvailability } from '@/lib/ticket-types';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await prisma.event.findFirst({ where: { id, isActive: true, publicationStatus: 'published' }, select: { id: true } });
  if (!event) return NextResponse.json({ success: false, error: 'Event not found', code: 'NOT_FOUND' }, { status: 404 });
  const types = await prisma.ticketType.findMany({ where: { eventId: id, active: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  return NextResponse.json({ success: true, items: types.map((type) => ({ ...type, availability: getTicketTypeAvailability(type) })) });
}
