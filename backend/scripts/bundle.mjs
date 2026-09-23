import * as esbuild from 'esbuild';
import { LAMBDA_ENTRIES } from './lambda-manifest.mjs';

await Promise.all(
  LAMBDA_ENTRIES.map(({ service, function: fn, entry }) =>
    esbuild.build({
      entryPoints: [entry],
      outfile: `dist/${service}/${fn}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      sourcemap: true,
      external: ['@aws-sdk/*'],
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    }),
  ),
);
