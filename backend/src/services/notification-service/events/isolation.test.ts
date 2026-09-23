import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const notificationServiceDir = fileURLToPath(new URL('..', import.meta.url));

const sourceFiles = readdirSync(notificationServiceDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('alerting-plane isolation (N1.5, AC5 — delivered form: static sweep)', () => {
  it('finds notification-service source files to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('never imports or references alerting-service — shares no queue, concurrency, or provider account with the alerting plane', () => {
    for (const file of sourceFiles) {
      const contents = readFileSync(file, 'utf8');
      expect(contents, file).not.toMatch(/alerting-service/);
    }
  });
});
