import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScanPayload } from '../lib/scan-payload';
import {
  generateTicketToken,
  generateTransferToken,
  ticketTokenMatches,
} from '../lib/ticket-security';
import { generateTimedQRToken, verifyTimedQRToken } from '../lib/qr-security';
import { sanitizeRichText, safeExternalUrl } from '../lib/sanitize-html';
import { isValidTimeSlot, mergeTimeSlots } from '../lib/time-slots';
import {
  allocatePaidAmount,
  calculateDynamicPrice,
  calculatePromoDiscount,
  calculateTicketUnitPrice,
} from '../lib/pricing';
import { attendeeSegmentFiltersSchema, buildAttendeeWhere } from '../lib/attendee-segments';
import { snapshotEventTemplate, templateChildren, templateEventCreateData } from '../lib/event-templates';
import { getEventStart, reminderOffsetLabel, reminderScheduledFor } from '../lib/reminders';
import { classifyOfflineSyncResponse } from '../lib/offline-checkin';
import { paginationMeta, parsePagination } from '../lib/pagination';
import { manualCheckInAllowed, readCheckInPolicy } from '../lib/checkin-policy';
import { calculateJobBackoffMs, nextJobStatus } from '../lib/background-jobs';
import { getTicketTypeAvailability, quoteTicketType } from '../lib/ticket-types';
import { normalizeRazorpayWebhook, razorpayWebhookKey } from '../lib/payment-reconciliation';
import { scannerHealthStatus } from '../lib/scanner-operations';
import { parseRegistrationFields, validateRegistrationAnswers } from '../lib/registration-forms';

process.env.TICKET_SECRET_KEY = process.env.TICKET_SECRET_KEY || 'test-ticket-secret';

function testScanPayloadParser() {
  assert.deepEqual(parseScanPayload('ticket-123'), { ticketId: 'ticket-123' });
  assert.deepEqual(parseScanPayload('ticket-123:secure-token'), {
    ticketId: 'ticket-123',
    token: 'secure-token',
  });
  assert.deepEqual(parseScanPayload(JSON.stringify({ ticketId: 'ticket-123', token: 'secure-token' })), {
    ticketId: 'ticket-123',
    token: 'secure-token',
    timedToken: undefined,
  });
  assert.deepEqual(parseScanPayload('https://example.com/ticket/ticket-123?token=secure-token'), {
    ticketId: 'ticket-123',
    token: 'secure-token',
    timedToken: undefined,
  });

  const timed = 'ticket-123:plain-token:l0d0:abcd1234:beadfeedbeadfeed';
  assert.deepEqual(parseScanPayload(timed), {
    ticketId: 'ticket-123',
    token: 'plain-token',
    timedToken: timed,
  });
  assert.equal(parseScanPayload('   '), null);
}

function testTicketSecurity() {
  const ticketId = 'ticket-123';
  const token = generateTicketToken(ticketId);
  const alteredToken = `${token[0] === '0' ? '1' : '0'}${token.slice(1)}`;
  assert.equal(ticketTokenMatches(token, token), true);
  assert.equal(ticketTokenMatches(token, alteredToken), false);
  assert.notEqual(generateTransferToken(ticketId), generateTransferToken(ticketId));

  const timedToken = generateTimedQRToken(ticketId, token);
  assert.deepEqual(verifyTimedQRToken(timedToken, token), { valid: true, ticketId });
  assert.equal(verifyTimedQRToken(timedToken, 'wrong-token').valid, false);
}

function testTimeSlots() {
  assert.equal(isValidTimeSlot({ startTime: '09:00', endTime: '10:00' }), true);
  assert.equal(isValidTimeSlot({ startTime: '10:00', endTime: '09:00' }), false);
  assert.deepEqual(
    mergeTimeSlots([
      [{ id: 'a', startTime: '11:00', endTime: '12:00' }],
      [{ id: 'b', startTime: '09:00', endTime: '10:00' }],
      [{ id: 'c', startTime: '09:00', endTime: '10:00' }],
    ]).map(slot => slot.id),
    ['b', 'a'],
  );
}

function testPricing() {
  const event = {
    price: 10000,
    soldCount: 80,
    capacity: 100,
    date: '2026-01-02T00:00:00.000Z',
    startTime: '09:00',
    PricingRule: [
      {
        id: 'demand',
        triggerType: 'DEMAND_BASED',
        triggerValue: 80,
        adjustmentType: 'PERCENTAGE',
        adjustmentValue: 10,
        active: true,
      },
      {
        id: 'time',
        triggerType: 'TIME_BASED',
        triggerValue: 48,
        adjustmentType: 'FIXED',
        adjustmentValue: 50,
        active: true,
      },
    ],
  };

  assert.equal(calculateDynamicPrice(event, new Date('2026-01-01T00:00:00.000Z')), 16000);
  assert.equal(calculateDynamicPrice(event, new Date('2025-12-01T00:00:00.000Z')), 11000);

  assert.equal(calculateTicketUnitPrice({
    ...event,
    earlyBirdEnabled: true,
    earlyBirdPrice: 7000,
    earlyBirdDeadline: '2026-01-01T12:00:00.000Z',
  }, new Date('2026-01-01T00:00:00.000Z')), 7000);

  assert.equal(calculatePromoDiscount(10000, { discountType: 'percentage', discountValue: 150 }), 10000);
  assert.equal(calculatePromoDiscount(10000, { discountType: 'fixed', discountValue: 25000 }), 10000);
  assert.deepEqual([0, 1, 2].map(index => allocatePaidAmount(100, 3, index)), [34, 33, 33]);
}

function testAttendeeSegments() {
  const filters = attendeeSegmentFiltersSchema.parse({
    statuses: ['paid'], checkedIn: false, hasEmail: true, search: 'shivam',
  });
  const where = buildAttendeeWhere(filters, ['event-1', 'event-2']);
  assert.deepEqual(where.eventId, { in: ['event-1', 'event-2'] });
  assert.deepEqual(where.status, { in: ['paid'] });
  assert.equal(where.checkedIn, false);
  assert.deepEqual(where.email, { not: null });
  assert.equal(Array.isArray(where.OR), true);
}

function testEventTemplates() {
  const snapshot = snapshotEventTemplate({ name: 'Ignored name', venue: 'Hall A', capacity: 250, soldCount: 99, isActive: true });
  assert.equal(snapshot.venue, 'Hall A');
  assert.equal(snapshot.capacity, 250);
  assert.equal('name' in snapshot, false);
  assert.equal('soldCount' in snapshot, false);
  const event = templateEventCreateData(snapshot, { name: 'Fresh Event', date: new Date('2026-12-01T00:00:00.000Z') });
  assert.equal(event.name, 'Fresh Event');
  assert.equal(event.soldCount, 0);
  assert.equal(event.isActive, false);
  assert.equal(event.sendReminders, false);
  assert.deepEqual(templateChildren({ _pricingRules: [{ triggerType: 'TIME_BASED' }], _sessions: [{ title: 'Opening' }] }), {
    pricingRules: [{ triggerType: 'TIME_BASED' }], sessions: [{ title: 'Opening' }],
  });
}

function testReminderScheduleMath() {
  const start = getEventStart(new Date('2026-09-20T00:00:00.000Z'), '09:30', 330);
  assert.equal(start.toISOString(), '2026-09-20T04:00:00.000Z');
  assert.equal(reminderScheduledFor(start, 1440).toISOString(), '2026-09-19T04:00:00.000Z');
  assert.equal(reminderOffsetLabel(1440), '1 day');
  assert.equal(reminderOffsetLabel(120), '2 hours');
}

function testManualCheckInPolicy() {
  const settings = {
    checkInPolicy: { manualCheckInEnabled: true, organizerApprovedEventIds: ['event-1'] },
    eventSettings: { 'event-1': { checkIn: { manualEnabled: true } } },
  };
  assert.equal(manualCheckInAllowed(settings, 'event-1', 'ORGANIZER'), true);
  assert.equal(manualCheckInAllowed(settings, 'event-2', 'ORGANIZER'), false);
  assert.equal(manualCheckInAllowed({ ...settings, eventSettings: { 'event-1': { checkIn: { manualEnabled: false } } } }, 'event-1', 'ORGANIZER'), false);
  assert.equal(manualCheckInAllowed({}, 'event-2', 'ADMIN'), true);
}

function testRegistrationForms() {
  const parsed = parseRegistrationFields([
    { id: 'size', type: 'select', label: 'T-shirt size', required: true, options: ['S', 'M'] },
    { id: 'consent', type: 'checkbox', label: 'I agree', required: true },
    { id: 'email', type: 'email', label: 'Contact email', required: false },
  ]);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.fields.length, 3);

  const missing = validateRegistrationAnswers(parsed.fields, { size: 'M', consent: false });
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0].message, /required/i);

  const invalid = validateRegistrationAnswers(parsed.fields, { size: 'XL', consent: true, email: 'not-an-email' });
  assert.equal(invalid.errors.length, 2);

  const valid = validateRegistrationAnswers(parsed.fields, { size: 'S', consent: true, email: 'person@example.com', ignored: 'drop me' });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.answers, { size: 'S', consent: true, email: 'person@example.com' });

  const invalidDefinition = parseRegistrationFields([{ id: 'bad', type: 'select', label: 'Bad', required: false, options: [] }]);
  assert.equal(invalidDefinition.fields.length, 0);
  assert.equal(invalidDefinition.errors.length, 1);
}

testScanPayloadParser();
testTicketSecurity();
testTimeSlots();
testPricing();
testAttendeeSegments();
testEventTemplates();
testReminderScheduleMath();
testManualCheckInPolicy();
testRegistrationForms();
console.log('All tests passed');

// ---------------------------------------------------------------------------
// api-helpers + Zod validation
// ---------------------------------------------------------------------------
import { z } from 'zod';
import { ApiError, badRequest, parseBody } from '../lib/api-helpers';

function testApiError() {
  const e = badRequest('missing field', { field: 'name' });
  assert.equal(e instanceof ApiError, true);
  assert.equal(e.status, 400);
  assert.equal(e.message, 'missing field');
  assert.deepEqual(e.details, { field: 'name' });
}

function testParseBodyRejectsInvalidJson() {
  const req = new Request('http://x', { method: 'POST', body: 'not json' });
  return parseBody(req as any, z.object({ name: z.string() })).then(
    () => { throw new Error('should have thrown'); },
    (err) => {
      assert.equal(err.status, 400);
    },
  );
}

function testParseBodyRejectsBadShape() {
  const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 123 }) });
  return parseBody(req as any, z.object({ name: z.string() })).then(
    () => { throw new Error('should have thrown'); },
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(Array.isArray(err.details));
    },
  );
}

function testParseBodyAcceptsValid() {
  const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'Shivam' }) });
  return parseBody(req as any, z.object({ name: z.string() })).then((data) => {
    assert.deepEqual(data, { name: 'Shivam' });
  });
}

testApiError();
testParseBodyRejectsInvalidJson();
testParseBodyRejectsBadShape();
testParseBodyAcceptsValid();

// ---------------------------------------------------------------------------
// Ticket lifecycle + scan payload + allocatePaidAmount idempotency
// ---------------------------------------------------------------------------
import {
  getTicketLifecycleStatus,
  getTicketFinancials,
  isPaidLikeStatus,
  PAID_LIKE_STATUSES,
} from '../lib/ticket-lifecycle';

function testTicketLifecycleStatus() {
  // pending
  assert.equal(getTicketLifecycleStatus({ status: 'pending' }), 'pending');
  // paid not yet checked in
  assert.equal(getTicketLifecycleStatus({ status: 'paid' }), 'paid');
  // paid and checked in -> 'checked_in'
  assert.equal(getTicketLifecycleStatus({ status: 'paid', checkedIn: true }), 'checked_in');
  // partially_refunded + checkedIn -> 'checked_in'
  assert.equal(getTicketLifecycleStatus({ status: 'partially_refunded', checkedIn: true }), 'checked_in');
  // cancelled
  assert.equal(getTicketLifecycleStatus({ status: 'cancelled' }), 'cancelled');
  // refunded
  assert.equal(getTicketLifecycleStatus({ status: 'refunded' }), 'refunded');
  // edge: null status
  assert.equal(isPaidLikeStatus(null), false);
  assert.equal(isPaidLikeStatus('paid'), true);
  assert.equal(isPaidLikeStatus('checked_in'), false);
}

function testTicketFinancials() {
  // No explicit financials: net == event price when paid
  const f1 = getTicketFinancials({ status: 'paid' }, 1000);
  assert.equal(f1.netAmount, 1000);
  assert.equal(f1.amountPaid, 1000);

  // With discount
  const f2 = getTicketFinancials({ status: 'paid', amountPaid: 800, discountAmount: 200 }, 1000);
  assert.equal(f2.netAmount, 800);
  assert.equal(f2.discountAmount, 200);

  // With refund
  const f3 = getTicketFinancials({ status: 'refunded', amountPaid: 0, grossAmount: 1000, refundedAmount: 1000 });
  assert.equal(f3.refundedAmount, 1000);
  assert.equal(f3.grossAmount, 1000);

  // Cancelled: no revenue
  const f4 = getTicketFinancials({ status: 'cancelled' }, 1000);
  assert.equal(f4.netAmount, 0);
  assert.equal(f4.grossAmount, 0);
}

function testTimedQRToken() {
  const ticketId = 'ticket-abc';
  const token = 'plain-secret-token';
  const timed = generateTimedQRToken(ticketId, token);

  // Correct token verifies
  const ok = verifyTimedQRToken(timed, token);
  assert.equal(ok.valid, true);
  assert.equal(ok.ticketId, ticketId);

  // Wrong token rejected
  const wrong = verifyTimedQRToken(timed, 'wrong');
  assert.equal(wrong.valid, false);
  assert.equal(wrong.reason, 'Invalid ticket token');

  // Tampered ticket id inside payload -> HMAC fails
  const parts = timed.split(':');
  parts[0] = 'ticket-other';
  const tampered = parts.join(':');
  const tamper = verifyTimedQRToken(tampered, token);
  assert.equal(tamper.valid, false);
  assert.equal(tamper.reason, 'Tampered QR code');

  // Garbage input
  const garbage = verifyTimedQRToken('not-a-qr', token);
  assert.equal(garbage.valid, false);
}


function testScanPayloadEdgeCases() {
  // Empty/whitespace -> null
  assert.equal(parseScanPayload(''), null);
  assert.equal(parseScanPayload('   '), null);
  // Plain id
  assert.deepEqual(parseScanPayload('T-001'), { ticketId: 'T-001' });
  // URL with query
  const url = 'https://example.com/ticket/abc-123?token=xyz';
  const r = parseScanPayload(url);
  assert.equal(r?.ticketId, 'abc-123');
  assert.equal(r?.token, 'xyz');
  // JSON object
  const j = parseScanPayload(JSON.stringify({ ticketId: 'json-1', token: 'j-tok' }));
  assert.deepEqual(j, { ticketId: 'json-1', token: 'j-tok', timedToken: undefined });
  // token:payload format
  const colon = parseScanPayload('T-007:secret');
  assert.equal(colon?.ticketId, 'T-007');
  assert.equal(colon?.token, 'secret');
}


function testPaidLikeStatuses() {
  assert.deepEqual([...PAID_LIKE_STATUSES], ['paid', 'partially_refunded']);
  assert.equal(isPaidLikeStatus('paid'), true);
  assert.equal(isPaidLikeStatus('partially_refunded'), true);
  assert.equal(isPaidLikeStatus('PENDING'), false);
}

function testContentSanitization() {
  const clean = sanitizeRichText('<p>Hello <strong>EventHub</strong></p><script>alert(1)</script><a href="javascript:alert(1)">bad</a>');
  assert.match(clean, /Hello/);
  assert.doesNotMatch(clean, /script|javascript:/i);
  assert.equal(safeExternalUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
}

function testDashboardSafetyHelpers() {
  assert.equal(classifyOfflineSyncResponse(200, {}), 'synced');
  assert.equal(classifyOfflineSyncResponse(400, { message: 'Ticket already checked in' }), 'synced');
  assert.equal(classifyOfflineSyncResponse(400, { message: 'Ticket payment is pending' }), 'retry');
  assert.equal(classifyOfflineSyncResponse(403, { message: 'Forbidden' }), 'retry');

  const parsed = parsePagination(new URLSearchParams('page=-2&pageSize=999'));
  assert.deepEqual(parsed, { page: 1, pageSize: 100, skip: 0 });
  assert.deepEqual(paginationMeta(2, 25, 51), { page: 2, pageSize: 25, total: 51, totalPages: 3 });

  assert.deepEqual(readCheckInPolicy({}), {
    manualCheckInEnabled: false,
    organizerApprovedEventIds: [],
  });
  assert.equal(readCheckInPolicy({ checkInPolicy: { manualCheckInEnabled: true, organizerApprovedEventIds: ['event-1'] } }).manualCheckInEnabled, true);
}

function testBackgroundJobLifecycle() {
  assert.equal(calculateJobBackoffMs(1), 60_000);
  assert.equal(calculateJobBackoffMs(3), 240_000);
  assert.equal(calculateJobBackoffMs(20), 3_600_000);
  assert.equal(nextJobStatus({ attempts: 2, maxAttempts: 3, retryable: true }), 'pending');
  assert.equal(nextJobStatus({ attempts: 3, maxAttempts: 3, retryable: true }), 'dead_letter');
  assert.equal(nextJobStatus({ attempts: 1, maxAttempts: 3, retryable: false }), 'dead_letter');
}

function testTicketTypeInventory() {
  const now = new Date('2026-09-13T12:00:00.000Z');
  const type = { active: true, salesStart: new Date('2026-09-01T00:00:00.000Z'), salesEnd: new Date('2026-09-30T00:00:00.000Z'), capacity: 50, soldCount: 10, price: 25_000, minPerOrder: 1, maxPerOrder: 4 };
  assert.deepEqual(getTicketTypeAvailability(type, now), { available: true, remaining: 40, reason: null });
  assert.deepEqual(quoteTicketType(type, 3, 90, now), { unitPrice: 25_000, quantity: 3, total: 75_000, remainingAfter: 37 });
  assert.throws(() => quoteTicketType(type, 5, 90, now), /maximum/i);
  assert.equal(getTicketTypeAvailability({ ...type, soldCount: 50 }, now).reason, 'sold_out');
  assert.equal(getTicketTypeAvailability({ ...type, salesStart: new Date('2026-09-20T00:00:00.000Z') }, now).reason, 'not_started');
}

function testPaymentReconciliationHelpers() {
  const payload = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 50000 } } } };
  assert.deepEqual(normalizeRazorpayWebhook(payload), { type: 'payment.captured', paymentId: 'pay_1', orderId: 'order_1', status: 'captured', amount: 50000 });
  assert.equal(razorpayWebhookKey(JSON.stringify(payload), 'signature'), razorpayWebhookKey(JSON.stringify(payload), 'signature'));
  assert.notEqual(razorpayWebhookKey(JSON.stringify(payload), 'signature'), razorpayWebhookKey(JSON.stringify(payload), 'other'));
}

function testScannerOperations() {
  const now = new Date('2026-09-13T12:00:00.000Z');
  assert.equal(scannerHealthStatus(new Date('2026-09-13T11:59:30.000Z'), now), 'online');
  assert.equal(scannerHealthStatus(new Date('2026-09-13T11:58:00.000Z'), now), 'degraded');
  assert.equal(scannerHealthStatus(new Date('2026-09-13T11:50:00.000Z'), now), 'offline');
  assert.equal(scannerHealthStatus(null, now), 'offline');
}

function testReliableOperationsSchemaContract() {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  for (const model of [
    'BackgroundJob',
    'WebhookEvent',
    'PaymentReconciliationAttempt',
    'TicketType',
    'ScannerHeartbeat',
    'StaffShift',
    'OperationalIncident',
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /ticketTypeId\s+String\?/);
}

testTicketLifecycleStatus();
testTicketFinancials();
testTimedQRToken();
testScanPayloadEdgeCases();
testPaidLikeStatuses();
testContentSanitization();
testDashboardSafetyHelpers();
testBackgroundJobLifecycle();
testTicketTypeInventory();
testPaymentReconciliationHelpers();
testScannerOperations();
testReliableOperationsSchemaContract();
