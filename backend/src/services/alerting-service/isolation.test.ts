import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const alertingServiceDir = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN_PATTERN =
  /platform-service|incident-service|PLATFORM_TABLE_NAME|INCIDENT_TABLE_NAME/;

const sourceFiles = readdirSync(alertingServiceDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('alerting-service IAM/data-plane isolation (AC3, NOTIF-ISO)', () => {
  it('finds alerting-service source files to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('never references platform-service or incident-service tables (app-level proxy for the IAM boundary)', () => {
    for (const file of sourceFiles) {
      const contents = readFileSync(file, 'utf8');
      expect(contents, file).not.toMatch(FORBIDDEN_PATTERN);
    }
  });

  it('the sweep pattern actually fails on a violation (negative control)', () => {
    expect('import { readIncidentTable } from "../incident-service/repository.js";').toMatch(
      FORBIDDEN_PATTERN,
    );
  });
});
