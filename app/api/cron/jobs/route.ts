import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { processBackgroundJobs } from '@/lib/job-worker';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'AUTHENTICATION_REQUIRED' }, { status: 401 });
  }
  const limit = Number(request.nextUrl.searchParams.get('limit') || 10);
  return NextResponse.json({ success: true, ...(await processBackgroundJobs(limit)) });
}
