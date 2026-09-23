import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findPkScopingViolations } from '../packages/dept-scope/src/index.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

const sourceFiles = readdirSync(srcDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
  )
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe('department-scoping pk sweep (AC3)', () => {
  it('finds source files under src/ to sweep', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('has zero pk-scoping violations across src/', () => {
    for (const file of sourceFiles) {
      const violations = findPkScopingViolations(readFileSync(file, 'utf8'));
      expect(violations, file).toEqual([]);
    }
  });
});
