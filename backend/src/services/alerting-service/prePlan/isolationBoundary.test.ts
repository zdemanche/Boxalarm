import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const prePlanDir = fileURLToPath(new URL('.', import.meta.url));

const forbiddenPatterns = [/inspections-service/, /PLATFORM_TABLE_NAME/, /platformTable/];

const sourceFiles = readdirSync(prePlanDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('alerting-service prePlan consumer isolation boundary (AC3)', () => {
  it('finds source files under prePlan/ to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('never imports inspections-service or the platform table config', () => {
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect(text, `${file} matched forbidden pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
