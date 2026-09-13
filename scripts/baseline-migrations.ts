import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
if (!apply) {
  console.error('Refusing to modify migration history. Re-run with --apply after reviewing the schema checks.');
  process.exit(2);
}

const prisma = new PrismaClient();
const baseline = [
  '20260812000000_remove_unused_features',
  '20260901120000_add_segments_reminders_templates',
  '20260904100000_event_publication_payment_recovery',
];

async function main() {
  const requiredTables = ['Event', 'Ticket', 'User', 'CheckInLog', 'AttendeeSegment', 'ReminderSchedule', 'PaymentRecoveryJob'];
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `;
  const present = new Set(rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`Schema is not eligible for baseline; missing tables: ${missing.join(', ')}`);
  for (const migration of baseline) execFileSync('npx', ['prisma', 'migrate', 'resolve', '--applied', migration], { stdio: 'inherit' });
  console.log('Baseline history registered. Run npm run db:migrate:deploy next.');
}

main().finally(() => prisma.$disconnect());
