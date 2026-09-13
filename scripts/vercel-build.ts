import { execFileSync } from 'node:child_process';

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: 'inherit', env: process.env });
}

if (process.env.RUN_DB_MIGRATIONS === '1') {
  run('npm', ['run', 'db:baseline']);
  run('npm', ['run', 'db:migrate:deploy']);
}

run('next', ['build']);
