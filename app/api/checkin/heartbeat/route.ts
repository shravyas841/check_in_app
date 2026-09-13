import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { forbidden, parseBody, respond, unauthorized } from '@/lib/api-helpers';
import { getSession, hasEventAccess } from '@/lib/auth';

const heartbeatSchema = z.object({
  eventId: z.string().min(1),
  deviceId: z.string().min(1).max(200),
  deviceName: z.string().max(200).optional(),
  networkStatus: z.enum(['online', 'offline', 'degraded']).optional(),
  cameraStatus: z.enum(['active', 'inactive', 'denied', 'unavailable']).optional(),
  appVersion: z.string().max(100).optional(),
  batteryLevel: z.number().int().min(0).max(100).optional(),
});

export const POST = respond(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) throw unauthorized();
  const body = await parseBody(request, heartbeatSchema);
  if (!hasEventAccess(session, body.eventId)) throw forbidden('You do not have access to this event');
  const heartbeat = await prisma.scannerHeartbeat.upsert({
    where: { userId_deviceId_eventId: { userId: session.user.id, deviceId: body.deviceId, eventId: body.eventId } },
    create: { id: randomUUID(), userId: session.user.id, ...body, lastSeenAt: new Date() },
    update: { ...body, lastSeenAt: new Date() },
    select: { id: true, lastSeenAt: true },
  });
  return NextResponse.json({ success: true, heartbeat });
}, { auth: 'scanner' });
