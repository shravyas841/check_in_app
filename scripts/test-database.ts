import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('TEST_DATABASE_URL is not configured; database integration test skipped.');
  process.exit(0);
}

const prisma = new PrismaClient({ datasourceUrl: url });
const id = randomUUID();
async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.operationalIncident.create({ data: { id, category: 'test', severity: 'info', source: 'integration-test', summary: 'Rollback verification' } });
      throw new Error('rollback');
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'rollback') throw error;
  }
  const leaked = await prisma.operationalIncident.findUnique({ where: { id } });
  if (leaked) throw new Error('Database transaction did not roll back');
  console.log('Database transaction rollback verified.');
}
main().finally(() => prisma.$disconnect());
