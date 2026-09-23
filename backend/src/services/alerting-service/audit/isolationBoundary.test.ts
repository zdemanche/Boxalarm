import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const auditDir = fileURLToPath(new URL('.', import.meta.url));

const forbiddenPatterns = [
  /platform-service/,
  /inspections-service/,
  /PLATFORM_TABLE_NAME/,
  /platformTable/,
];

const sourceFiles = readdirSync(auditDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('alerting-service audit query isolation boundary (C-2)', () => {
  it('finds source files under audit/ to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('never imports another plane service or its table config', () => {
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect(text, `${file} matched forbidden pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
