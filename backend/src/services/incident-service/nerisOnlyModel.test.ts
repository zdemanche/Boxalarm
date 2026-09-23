import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Spell the banned legacy acronym without embedding it as a contiguous token in this file. */
const BANNED = ['N', 'F', 'I', 'R', 'S'].join('');

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('incident-service must not reference the retired reporting model (AC2)', () => {
  it(`fails if ${BANNED} appears under incident-service source`, () => {
    const pattern = new RegExp(BANNED, 'i');
    const offenders: string[] = [];

    for (const file of listSourceFiles(SERVICE_ROOT)) {
      const rel = relative(SERVICE_ROOT, file);
      if (rel === 'nerisOnlyModel.test.ts') {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      if (pattern.test(text)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
