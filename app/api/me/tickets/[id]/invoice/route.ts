import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ success: false, error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' }, { status: 401 });
  const { id } = await params;
  const ticket = await prisma.ticket.findFirst({
    where: { id, OR: [{ userId: session.user.id }, ...(session.user.email ? [{ email: session.user.email }] : [])] },
    select: { id: true, status: true },
  });
  if (!ticket) return NextResponse.json({ success: false, error: 'Ticket not found', code: 'NOT_FOUND' }, { status: 404 });
  if (!['paid', 'partially_refunded', 'refunded'].includes(ticket.status)) return NextResponse.json({ success: false, error: 'A receipt is available after payment', code: 'VALIDATION_ERROR' }, { status: 400 });
  return NextResponse.redirect(new URL(`/api/tickets/${encodeURIComponent(id)}/pdf`, request.url));
}
