import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const personnelServiceDir = fileURLToPath(new URL('..', import.meta.url));

const sourceFiles = readdirSync(personnelServiceDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('alerting-plane isolation (AC4/N1.5)', () => {
  it('finds personnel-service source files to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('never imports or references alerting-service from personnel-service (no synchronous cross-service call)', () => {
    for (const file of sourceFiles) {
      const contents = readFileSync(file, 'utf8');
      expect(contents, file).not.toMatch(/alerting-service/);
    }
  });
});
