import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasEventAccess, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { isPaidLikeStatus } from '@/lib/ticket-lifecycle';

interface ImportRow {
    name?: string;
    email?: string;
    phone?: string;
    amountPaid?: number;
    status?: string;
    notes?: string;
}

function parseCSV(text: string): ImportRow[] {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return [];
    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''));
    const rows: ImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim());
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => {
            row[h] = cols[idx] ?? '';
        });
        rows.push({
            name: row['name'] || row['fullname'] || row['attendee'],
            email: row['email'],
            phone: row['phone'] || row['mobile'],
            amountPaid: row['amount'] || row['amountpaid']
                ? Number((row['amount'] || row['amountpaid']).replace(/[^0-9.]/g, '')) * 100
                : undefined,
            status: row['status'] || 'paid',
            notes: row['notes'] || row['comment'],
        });
    }
    return rows;
}

export async function POST(request: NextRequest) {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!hasRole(session.user.role, ORGANIZER_ROLES)) {
        return NextResponse.json({ error: 'Organizer role required' }, { status: 403 });
    }

    const url = new URL(request.url);
    const eventId = url.searchParams.get('eventId');
    if (!eventId) return NextResponse.json({ error: 'eventId required' }, { status: 400 });
    if (!hasEventAccess(session, eventId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const contentType = request.headers.get('content-type') || '';
    let rows: ImportRow[] = [];
    if (contentType.includes('application/json')) {
        const body = await request.json();
        rows = Array.isArray(body) ? body : body.rows || [];
    } else if (
        contentType.includes('text/csv') ||
        contentType.includes('text/plain') ||
        contentType.includes('multipart/form-data')
    ) {
        const text = await request.text();
        rows = parseCSV(text);
    } else {
        return NextResponse.json({ error: 'Unsupported content-type' }, { status: 415 });
    }

    if (rows.length === 0) {
        return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
    }
    if (rows.length > 1000) {
        return NextResponse.json({ error: 'Imports are limited to 1000 rows per request' }, { status: 413 });
    }

    // Validate event and capacity
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, capacity: true, soldCount: true, price: true },
    });
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    const allowedStatuses = new Set(['pending', 'paid', 'partially_refunded', 'refunded', 'cancelled']);
    const normalizedRows = rows.filter((row) => Boolean(String(row.name || '').trim())).map((row) => {
        const amountPaid = typeof row.amountPaid === 'number' && Number.isFinite(row.amountPaid) && row.amountPaid >= 0
            ? Math.round(row.amountPaid)
            : event.price;
        return {
            ...row,
            name: String(row.name).trim(),
            email: typeof row.email === 'string' ? row.email.trim() || undefined : undefined,
            phone: typeof row.phone === 'string' ? row.phone.trim() || undefined : undefined,
            amountPaid,
            status: allowedStatuses.has(row.status || '') ? row.status as string : 'paid',
        };
    });
    const remainingPaid = Math.max(0, event.capacity - event.soldCount);
    let paidSlots = 0;
    const toInsert = normalizedRows.filter((row) => {
        if (!isPaidLikeStatus(row.status)) return true;
        if (paidSlots >= remainingPaid) return false;
        paidSlots += 1;
        return true;
    });
    const skipped = rows.length - toInsert.length;
    const paidToInsert = toInsert.filter((row) => isPaidLikeStatus(row.status)).length;

    const created = await prisma.$transaction(async (tx) => {
        if (paidToInsert > 0) {
            const capacityUpdate = await tx.event.updateMany({
                where: { id: eventId, soldCount: { lte: event.capacity - paidToInsert } },
                data: { soldCount: { increment: paidToInsert } },
            });
            if (capacityUpdate.count !== 1) throw new Error('Not enough tickets are available for this event');
        }

        const imported: any[] = [];
        for (const row of toInsert) {
            imported.push(await tx.ticket.create({
                data: {
                    id: crypto.randomUUID(),
                    name: row.name,
                    email: row.email,
                    phone: row.phone,
                    eventId,
                    status: row.status,
                    amountPaid: row.amountPaid,
                    grossAmount: row.amountPaid,
                    paymentMethod: 'import',
                },
            }));
        }
        return imported;
    });

    return NextResponse.json({
        imported: created.length,
        skipped,
        tickets: created,
    });
}
