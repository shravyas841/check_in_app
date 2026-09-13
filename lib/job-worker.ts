import { randomUUID } from 'node:crypto';
import { claimNextJob, completeJob, failJob, recoverStaleClaims } from '@/lib/job-queue';
import { handleBackgroundJob } from '@/lib/job-handlers';

export async function processBackgroundJobs(limit = 10) {
  const workerId = `web-${randomUUID()}`;
  const recovered = await recoverStaleClaims();
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < Math.min(50, Math.max(1, limit)); index += 1) {
    const job = await claimNextJob(workerId);
    if (!job) break;
    try {
      await handleBackgroundJob(job);
      await completeJob(job.id);
      processed += 1;
    } catch (error) {
      await failJob(job.id, error);
      failed += 1;
    }
  }
  return { processed, failed, recovered };
}
