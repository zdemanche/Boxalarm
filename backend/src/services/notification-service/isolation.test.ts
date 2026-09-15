import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const notificationServiceDir = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN_PATTERN =
  /alerting-service|ALERTING_TABLE_NAME|alerting-topic|alerting-push-queue|alerting-sms-queue|alerting-voice-queue/;

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
});
