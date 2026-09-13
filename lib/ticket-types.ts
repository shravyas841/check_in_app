export interface TicketTypeInventory {
  active: boolean;
  salesStart: Date | null;
  salesEnd: Date | null;
  capacity: number;
  soldCount: number;
  price: number;
  minPerOrder: number;
  maxPerOrder: number;
}

export type TicketTypeAvailabilityReason = 'inactive' | 'not_started' | 'ended' | 'sold_out' | null;

export function getTicketTypeAvailability(type: TicketTypeInventory, now = new Date()) {
  const remaining = Math.max(0, type.capacity - type.soldCount);
  let reason: TicketTypeAvailabilityReason = null;
  if (!type.active) reason = 'inactive';
  else if (type.salesStart && type.salesStart.getTime() > now.getTime()) reason = 'not_started';
  else if (type.salesEnd && type.salesEnd.getTime() < now.getTime()) reason = 'ended';
  else if (remaining === 0) reason = 'sold_out';
  return { available: reason === null, remaining, reason };
}

export function quoteTicketType(type: TicketTypeInventory, quantity: number, eventRemaining: number, now = new Date()) {
  if (!Number.isInteger(quantity) || quantity < type.minPerOrder) throw new Error(`Minimum quantity is ${type.minPerOrder}`);
  if (quantity > type.maxPerOrder) throw new Error(`Maximum quantity is ${type.maxPerOrder}`);
  const availability = getTicketTypeAvailability(type, now);
  if (!availability.available) throw new Error(`Ticket type is unavailable: ${availability.reason}`);
  if (quantity > availability.remaining || quantity > eventRemaining) throw new Error('Not enough ticket inventory');
  return { unitPrice: type.price, quantity, total: type.price * quantity, remainingAfter: availability.remaining - quantity };
}
