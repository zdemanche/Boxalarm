import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The deadline worker must work in the DEPLOYED bundle, not just under vitest: bundled with the
 * exact esbuild options of scripts/bundle.mjs (minify + keepNames), a worker built from
 * Function.prototype.toString referenced esbuild's module-level __name helper and failed on
 * every message (every CAD dispatch would have paged RAW).
 */
describe('parseCadTextBounded in a Lambda-style bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-parser-bundle-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('parses in the worker and still times out a catastrophic pattern', async () => {
    const entry = join(dir, 'entry.ts');
    writeFileSync(
      entry,
      `import { parseCadTextBounded } from ${JSON.stringify(join(__dirname, 'index.ts'))};
export const run = async () => ({
  ok: await parseCadTextBounded({ version: 1, fields: { address: { label: 'ADDR' } } }, 'ADDR: 1 MAIN ST'),
  slow: await parseCadTextBounded({ version: 1, fields: { address: { pattern: '((a)+)+$' } } }, 'a'.repeat(40) + '!', 300),
});`,
    );
    const outfile = join(dir, 'out.mjs');
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: true,
      keepNames: true,
      logLevel: 'silent',
    });
    const { run } = (await import(pathToFileURL(outfile).href)) as {
      run: () => Promise<{ ok: unknown; slow: unknown }>;
    };
    const result = await run();
    expect(result.ok).toMatchObject({ status: 'PARSED', fields: { address: '1 MAIN ST' } });
    expect(result.slow).toMatchObject({ status: 'RAW', reason: 'TIMEOUT' });
  }, 20_000);
});
