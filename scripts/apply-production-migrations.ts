import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const migrationName = '20260913120000_reliable_operations';
const migrationFile = join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql');
const markerTable = '_codex_release_migrations';

function pooledConnectionString() {
  const url = process.env.POSTGRES_PRISMA_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Missing POSTGRES_PRISMA_URL or DATABASE_URL for production migration.');

  // pg applies sslmode=require from the connection string before the explicit
  // SSL options. Remove it so Supabase's certificate chain can be accepted by
  // the build runner while transport encryption remains enabled.
  return url.replace(/([?&])sslmode=[^&]*/, '$1').replace(/[?&]$/, '');
}

async function main() {
  const client = new Client({
    connectionString: pooledConnectionString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  });

  await client.connect();
  const lockKey = 'eventhub:production:migrations';

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${markerTable}" (
        "name" TEXT PRIMARY KEY,
        "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const existing = await client.query(`SELECT 1 FROM "${markerTable}" WHERE "name" = $1`, [migrationName]);
    if (existing.rowCount) {
      await client.query('COMMIT');
      console.log(`Production migration already applied: ${migrationName}`);
      return;
    }

    await client.query(readFileSync(migrationFile, 'utf8'));
    await client.query(`INSERT INTO "${markerTable}" ("name") VALUES ($1)`, [migrationName]);
    await client.query('COMMIT');
    console.log(`Applied production migration: ${migrationName}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
