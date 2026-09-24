import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { placeholderLambdaCode } from "./placeholder-code";

export const LAMBDA_HANDLER = "index.handler";

const BACKEND_DIST_ROOT = path.resolve(__dirname, "../../../backend/dist");

/**
 * Returns the bundled backend/dist/<service>/<function>/index.mjs archive
 * (from `npm run bundle` in backend/) when it exists, else the fail-closed
 * 501 placeholder — so infra unit tests and `pulumi preview` still work
 * without a backend build.
 *
 * Deploying with a missing bundle is a silent regression from working code
 * to the 501 stub, so the fallback is logged as a Pulumi warning (visible in
 * `pulumi preview`/`pulumi up` output) instead of failing quietly. Run
 * `cd backend && npm run bundle` before deploying — see infrastructure/README.md.
 */
export function lambdaCode(service: string, functionName: string): pulumi.asset.Archive {
  const dir = path.join(BACKEND_DIST_ROOT, service, functionName);
  if (fs.existsSync(path.join(dir, "index.mjs"))) {
    return new pulumi.asset.FileArchive(dir);
  }
  pulumi.log.warn(
    `lambdaCode: no bundle found for ${service}/${functionName} at ${dir} — ` +
      `deploying the fail-closed 501 placeholder instead. Run "cd backend && npm run bundle" first.`,
  );
  return placeholderLambdaCode();
}
