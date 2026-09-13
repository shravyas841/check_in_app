import { NextRequest, NextResponse } from 'next/server';
import { processDueReminders } from '@/lib/reminders';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'AUTHENTICATION_REQUIRED' },
      { status: 401 },
    );
  }
  try {
    return NextResponse.json({ success: true, ...(await processDueReminders()) });
  } catch (error) {
    console.error('[reminders cron]', error);
    return NextResponse.json(
      { success: false, error: 'Reminder processing failed', code: 'JOB_PROCESSING_ERROR' },
      { status: 500 },
    );
  }
}
