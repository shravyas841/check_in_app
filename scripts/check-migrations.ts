import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../prisma/migrations/', import.meta.url);
const manifestPath = new URL('../prisma/migrations/checksums.json', import.meta.url);
const expected = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>;
const directories = readdirSync(root).filter((name) => /^\d+_/.test(name)).sort();
const actual: Record<string, string> = {};
for (const directory of directories) {
  const sql = readFileSync(join(root.pathname, directory, 'migration.sql'));
  actual[directory] = createHash('sha256').update(sql).digest('hex');
}
const missing = Object.keys(expected).filter((name) => !actual[name]);
const changed = Object.keys(expected).filter((name) => actual[name] && actual[name] !== expected[name]);
const untracked = Object.keys(actual).filter((name) => !expected[name]);
if (missing.length || changed.length || untracked.length) {
  console.error(JSON.stringify({ missing, changed, untracked }, null, 2));
  process.exit(1);
}
console.log(`Verified ${directories.length} immutable migration checksums.`);
