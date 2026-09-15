import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TODO: E1-S13 AC2 infra provisioning and AC4 chaos/load isolation exercise (NOTIF-ISO row) are owned by boxalarm-infrastructure; this file is an app-level static proxy only.
const notificationServiceDir = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN_PATTERN =
  /alerting-service|\bALERTING(_DISPATCHES)?_TABLE_NAME\b|alerting-topic|alerting-[a-z]+-queue/;

const sourceFiles = readdirSync(notificationServiceDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('notification-service plane isolation (AC2, NOTIF-ISO)', () => {
  it('finds notification-service source files to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('never references the alerting plane’s table, topic, or queues (consumes only the platform bus)', () => {
    for (const file of sourceFiles) {
      const contents = readFileSync(file, 'utf8');
      expect(contents, file).not.toMatch(FORBIDDEN_PATTERN);
    }
  });

  it('the sweep pattern actually fails on a violation (negative control)', () => {
    expect('const queue = "boxalarm-prod-alerting-push-queue.fifo";').toMatch(FORBIDDEN_PATTERN);
  });

  it.each([
    'process.env.ALERTING_DISPATCHES_TABLE_NAME',
    'const queue = "boxalarm-prod-alerting-receipts-queue.fifo";',
  ])('the sweep pattern fails on %s (negative control)', (violation) => {
    expect(violation).toMatch(FORBIDDEN_PATTERN);
  });
});
