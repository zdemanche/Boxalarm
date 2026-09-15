import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TODO: E1-S13 AC1/AC3 IAM policy enforcement and AC4 chaos/load isolation exercise (NOTIF-ISO row) are owned by boxalarm-infrastructure; this file is an app-level static proxy only.
const alertingServiceDir = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN_PATTERN =
  /platform-service|incident-service|\b(PLATFORM(_SERVICE)?|PERSONNEL|INCIDENT|AUDIT|OCCUPANCY|TRAINING(_DYNAMO)?)_TABLE_NAME\b/;

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

  it.each([
    'process.env.PLATFORM_SERVICE_TABLE_NAME',
    'process.env.PERSONNEL_TABLE_NAME',
    'process.env.AUDIT_TABLE_NAME',
    'process.env.OCCUPANCY_TABLE_NAME',
    'process.env.TRAINING_TABLE_NAME',
    'process.env.TRAINING_DYNAMO_TABLE_NAME',
  ])('the sweep pattern fails on %s (negative control)', (violation) => {
    expect(violation).toMatch(FORBIDDEN_PATTERN);
  });
});
