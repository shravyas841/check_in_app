import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession, hasEventAccess, hasRole, ORGANIZER_ROLES } from '@/lib/auth';
import { DEFAULT_TIME_SLOTS, isValidTimeSlot, sortTimeSlots, type TimeSlot } from '@/lib/time-slots';

export const dynamic = 'force-dynamic';

type SiteSettings = Record<string, unknown> & {
  sessionTimeSlotsByEvent?: Record<string, TimeSlot[]>;
};

function asSettings(value: unknown): SiteSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as SiteSettings;
}

function getSlotMap(settings: SiteSettings) {
  const map = settings.sessionTimeSlotsByEvent;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

async function readSettings() {
  const config = await prisma.siteConfig.findUnique({
    where: { id: 'default' },
    select: { settings: true },
  });

  return asSettings(config?.settings);
}

async function writeSettings(settings: SiteSettings) {
  const jsonSettings = settings as Prisma.InputJsonObject;
  await prisma.siteConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      settings: jsonSettings,
      updatedAt: new Date(),
    },
    update: {
      settings: jsonSettings,
      updatedAt: new Date(),
    },
  });
}

async function requireEventAccess(eventId: string) {
  const session = await getSession();
  return !!session && hasRole(session.user.role, ORGANIZER_ROLES) && hasEventAccess(session, eventId);
}

function normalizeSlot(input: unknown): TimeSlot | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Partial<TimeSlot>;
  const slot = {
    id: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : `slot-${crypto.randomUUID()}`,
    startTime: typeof data.startTime === 'string' ? data.startTime.trim() : '',
    endTime: typeof data.endTime === 'string' ? data.endTime.trim() : '',
    label: typeof data.label === 'string' ? data.label.trim() : undefined,
  };

  return isValidTimeSlot(slot) ? slot : null;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!(await requireEventAccess(id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await readSettings();
    const slotMap = getSlotMap(settings);
    const slots = Object.prototype.hasOwnProperty.call(slotMap, id)
      ? slotMap[id]
      : DEFAULT_TIME_SLOTS;

    return NextResponse.json(sortTimeSlots(slots || []));
  } catch (error) {
    console.error('Slot fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch slots' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!(await requireEventAccess(id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const slot = normalizeSlot(await request.json());
    if (!slot) {
      return NextResponse.json({ error: 'Valid start and end times are required' }, { status: 400 });
    }

    const settings = await readSettings();
    const slotMap = { ...getSlotMap(settings) };
    const currentSlots = Object.prototype.hasOwnProperty.call(slotMap, id)
      ? slotMap[id] || []
      : DEFAULT_TIME_SLOTS;

    slotMap[id] = sortTimeSlots([...currentSlots.filter(existing => existing.id !== slot.id), slot]);
    await writeSettings({ ...settings, sessionTimeSlotsByEvent: slotMap });

    return NextResponse.json(slot, { status: 201 });
  } catch (error) {
    console.error('Slot create error:', error);
    return NextResponse.json({ error: 'Failed to create slot' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!(await requireEventAccess(id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const slotId = request.nextUrl.searchParams.get('slotId');
    const settings = await readSettings();
    const slotMap = { ...getSlotMap(settings) };
    const currentSlots = Object.prototype.hasOwnProperty.call(slotMap, id)
      ? slotMap[id] || []
      : DEFAULT_TIME_SLOTS;

    slotMap[id] = slotId
      ? currentSlots.filter(slot => slot.id !== slotId)
      : [];

    await writeSettings({ ...settings, sessionTimeSlotsByEvent: slotMap });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Slot delete error:', error);
    return NextResponse.json({ error: 'Failed to delete slot' }, { status: 500 });
  }
}
