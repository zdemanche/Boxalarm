import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const alertingServiceDir = fileURLToPath(
  new URL('../src/services/alerting-service', import.meta.url),
);

const LOB_SERVICE_NAMES = [
  'apparatus-service',
  'personnel-service',
  'platform-service',
  'inspections-service',
  'training-service',
  'reporting-service',
  'inventory-service',
  'incident-service',
  'notification-service',
];

const sourceFiles = readdirSync(alertingServiceDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('alerting-plane isolation from the LOB plane (N1.5)', () => {
  it('finds alerting-service source files to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(LOB_SERVICE_NAMES)(
    'never imports or references %s (no synchronous cross-plane call)',
    (lobService) => {
      for (const file of sourceFiles) {
        const contents = readFileSync(file, 'utf8');
        expect(contents, file).not.toMatch(new RegExp(lobService));
      }
    },
  );
});
