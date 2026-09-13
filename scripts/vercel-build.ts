import { execFileSync } from 'node:child_process';

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: 'inherit', env: process.env });
}

if (process.env.RUN_DB_MIGRATIONS === '1') {
  // Prisma schema changes must use the direct database connection. Supabase's
  // transaction pooler can serve application traffic, but it can hang during
  // migration-history inspection and DDL operations.
  const migrationUrl = process.env.POSTGRES_URL_NON_POOLING;
  if (migrationUrl) {
    process.env.POSTGRES_PRISMA_URL = migrationUrl;
    process.env.DATABASE_URL = migrationUrl;
  }
  run('npm', ['run', 'db:baseline']);
  run('npm', ['run', 'db:migrate:deploy']);
}

run('next', ['build']);
