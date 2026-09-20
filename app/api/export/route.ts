import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasEventAccess } from '@/lib/auth';
import { PAID_LIKE_STATUSES } from '@/lib/ticket-lifecycle';

const ALLOWED_ROLES = ['ADMIN', 'ORGANIZER', 'ORGANISER'];

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
    if (!ALLOWED_ROLES.includes(session.user.role)) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const url = new URL(req.url);
    const eventId = url.searchParams.get('eventId');
    const format = url.searchParams.get('format') || 'csv'; // csv | xlsx | json
    const type = url.searchParams.get('type') || 'tickets'; // tickets | analytics | checkins

    if (type === 'analytics' && session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Admin access required for sales exports' }, { status: 403 });
    }

    if (!eventId) {
      return NextResponse.json({ error: 'Event ID is required' }, { status: 400 });
    }

    if (!hasEventAccess(session, eventId)) {
      return NextResponse.json({ error: 'You do not have access to this event' }, { status: 403 });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (type === 'checkins') {
      return exportCheckins(eventId, event, format);
    }

    if (type === 'analytics') {
      return exportAnalytics(eventId, event, format);
    }

    // Default: ticket export
    return exportTickets(eventId, event, format);
  } catch (error: any) {
    console.error('Export error:', error);
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}

async function exportTickets(eventId: string, event: any, format: string) {
  const tickets = await prisma.ticket.findMany({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
  });

  const registrationFields = (event.registrationFields as any[]) || [];
  const standardHeaders = ['Ticket ID', 'Name', 'Email', 'Phone', 'Status', 'Amount Paid', 'Checked In', 'Checked In At', 'Purchase Date', 'Promo Code'];
  const customHeaders = registrationFields.map((field: any) => field.label);
  const allHeaders = [...standardHeaders, ...customHeaders];

  const rows = tickets.map((ticket: any) => {
    const answers = (ticket.customAnswers as Record<string, any>) || {};
    const row = [
      ticket.id,
      ticket.name,
      ticket.email || '',
      ticket.phone || '',
      ticket.status,
      ticket.amountPaid || 0,
      ticket.checkedIn ? 'Yes' : 'No',
      ticket.checkedInAt ? new Date(ticket.checkedInAt).toISOString() : '',
      new Date(ticket.createdAt).toISOString(),
      ticket.promoCodeId || '',
    ];
    for (const field of registrationFields) {
      row.push(answers[field.id] ?? '');
    }
    return row;
  });

  if (format === 'json') {
    return NextResponse.json({ headers: allHeaders, rows, event: { name: event.name, id: event.id } });
  }

  if (format === 'xlsx') {
    return generateXLSX(allHeaders, rows, `tickets-${eventId}`);
  }

  // CSV
  return generateCSV(allHeaders, rows, `tickets-${eventId}`);
}

async function exportCheckins(eventId: string, event: any, format: string) {
  const tickets = await prisma.ticket.findMany({
    where: { eventId, checkedIn: true },
    orderBy: { checkedInAt: 'desc' },
  });

  const headers = ['Ticket ID', 'Name', 'Email', 'Phone', 'Checked In At', 'Checked In By'];
  const rows = tickets.map((ticket: any) => [
    ticket.id,
    ticket.name,
    ticket.email || '',
    ticket.phone || '',
    ticket.checkedInAt ? new Date(ticket.checkedInAt).toISOString() : '',
    ticket.checkedInBy || '',
  ]);

  if (format === 'json') {
    return NextResponse.json({ headers, rows, event: { name: event.name, id: event.id } });
  }
  if (format === 'xlsx') return generateXLSX(headers, rows, `checkins-${eventId}`);
  return generateCSV(headers, rows, `checkins-${eventId}`);
}

async function exportAnalytics(eventId: string, event: any, format: string) {
  const [totalTickets, paidTickets, checkedIn, ticketsForRevenue] = await Promise.all([
    prisma.ticket.count({ where: { eventId } }),
    prisma.ticket.count({ where: { eventId, status: { in: [...PAID_LIKE_STATUSES] } } }),
    prisma.ticket.count({ where: { eventId, checkedIn: true } }),
    prisma.ticket.findMany({
      where: { eventId, status: { in: [...PAID_LIKE_STATUSES, 'refunded'] } },
      select: { createdAt: true, status: true, amountPaid: true, Event: { select: { price: true } } },
    }),
  ]);

  const netRevenue = ticketsForRevenue
    .filter((ticket: any) => PAID_LIKE_STATUSES.includes(ticket.status))
    .reduce((sum: number, ticket: any) => sum + (ticket.amountPaid || ticket.Event.price || 0), 0);
  const refundedAmount = ticketsForRevenue
    .filter((ticket: any) => ticket.status === 'refunded')
    .reduce((sum: number, ticket: any) => sum + (ticket.amountPaid || ticket.Event.price || 0), 0);

  // Daily breakdown
  const dailyMap: Record<string, number> = {};
  ticketsForRevenue.filter((ticket: any) => PAID_LIKE_STATUSES.includes(ticket.status)).forEach((t: any) => {
    const day = new Date(t.createdAt).toISOString().split('T')[0];
    dailyMap[day] = (dailyMap[day] || 0) + 1;
  });

  const headers = ['Metric', 'Value'];
  const rows = [
    ['Event Name', event.name],
    ['Total Registrations', totalTickets.toString()],
    ['Paid Tickets', paidTickets.toString()],
    ['Checked In', checkedIn.toString()],
    ['Check-in Rate', paidTickets > 0 ? `${((checkedIn / paidTickets) * 100).toFixed(1)}%` : '0%'],
    ['Gross Revenue', ((netRevenue + refundedAmount) / 100).toFixed(2)],
    ['Refunded Amount', (refundedAmount / 100).toFixed(2)],
    ['Net Revenue', (netRevenue / 100).toFixed(2)],
    ['Capacity', event.capacity.toString()],
    ['Sold Rate', event.capacity > 0 ? `${((paidTickets / event.capacity) * 100).toFixed(1)}%` : 'N/A'],
    ['', ''],
    ['Daily Breakdown', ''],
    ['Date', 'Tickets Sold'],
    ...Object.entries(dailyMap).sort().map(([date, count]) => [date, count.toString()]),
  ];

  if (format === 'json') {
    return NextResponse.json({ headers, rows, event: { name: event.name, id: event.id } });
  }
  if (format === 'xlsx') return generateXLSX(headers, rows, `analytics-${eventId}`);
  return generateCSV(headers, rows, `analytics-${eventId}`);
}

function generateCSV(headers: string[], rows: string[][], filename: string) {
  const csvContent = [
    headers.map(h => `"${h}"`).join(','),
    ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}-${new Date().toISOString().split('T')[0]}.csv"`,
    },
  });
}

function generateXLSX(headers: string[], rows: string[][], filename: string) {
  // Generate a simple XML-based Excel file (XLSX-compatible .xls)
  // This is a lightweight approach that doesn't require additional dependencies
  const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="header">
      <Font ss:Bold="1" ss:Size="12"/>
      <Interior ss:Color="#E11D2E" ss:Pattern="Solid"/>
      <Font ss:Color="#FFFFFF" ss:Bold="1"/>
    </Style>
    <Style ss:ID="data">
      <Font ss:Size="11"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="Export">
    <Table>
      <Row ss:StyleID="header">
        ${headers.map(h => `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('\n        ')}
      </Row>
      ${rows.map(row => `<Row ss:StyleID="data">
        ${row.map(cell => `<Cell><Data ss:Type="String">${escapeXml(String(cell))}</Data></Cell>`).join('\n        ')}
      </Row>`).join('\n      ')}
    </Table>
  </Worksheet>
</Workbook>`;

  return new NextResponse(xmlContent, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': `attachment; filename="${filename}-${new Date().toISOString().split('T')[0]}.xls"`,
    },
  });
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
