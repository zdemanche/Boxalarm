import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const deltaPath = process.argv[2];
if (!deltaPath) {
  console.error('usage: node scripts/apply-lock-delta.mjs <delta.json>');
  process.exit(1);
}

const lockFile = resolve(process.cwd(), 'package-lock.json');
const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
const delta = JSON.parse(readFileSync(resolve(process.cwd(), deltaPath), 'utf8'));

Object.assign(lock.packages, delta.packages ?? {});
writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
console.log(`applied ${Object.keys(delta.packages ?? {}).length} package-lock entries from ${deltaPath}`);
