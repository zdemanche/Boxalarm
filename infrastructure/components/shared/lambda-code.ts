import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { placeholderLambdaCode } from "./placeholder-code";

export const LAMBDA_HANDLER = "index.handler";

const BACKEND_DIST_ROOT = path.resolve(__dirname, "../../../backend/dist");

/**
 * Stacks that may deploy the placeholder in place of a missing bundle: dev, and "stack" - the
 * name the Pulumi runtime reports when no stack is set (unit tests without mocks). Any real
 * deploy stack, including one added later, is refused.
 */
const PLACEHOLDER_STACKS = new Set(["dev", "stack"]);

/**
 * Returns the bundled backend/dist/<service>/<function>/index.mjs archive
 * (from `npm run bundle` in backend/) when it exists, else the fail-closed
 * placeholder — so infra unit tests and a dev `pulumi preview` still work
 * without a backend build.
 *
 * Every stack other than dev FAILS on a missing bundle (design review M5): a
 * qa/staging/prod deploy of the placeholder replaces working paging code. On
 * dev the fallback is a loud Pulumi warning, and the placeholder throws on
 * every non-HTTP trigger (placeholder-code.ts), so a stream or queue event
 * retries into its DLQ instead of being acknowledged. Run
 * `cd backend && npm run bundle` before deploying — see infrastructure/README.md.
 */
export function lambdaCode(
  service: string,
  functionName: string,
  /**
   * Replaces the placeholder for a function that isn't an HTTP route handler - e.g. the
   * API authorizer, where a 501 body is not a valid authorizer response and API Gateway would
   * answer 500 instead of a clean deny. Must still fail closed and use LAMBDA_HANDLER.
   */
  fallback?: () => pulumi.asset.Archive,
): pulumi.asset.Archive {
  const dir = path.join(BACKEND_DIST_ROOT, service, functionName);
  if (fs.existsSync(path.join(dir, "index.mjs"))) {
    return new pulumi.asset.FileArchive(dir);
  }
  const stack = pulumi.getStack();
  if (!PLACEHOLDER_STACKS.has(stack)) {
    throw new Error(
      `lambdaCode: no bundle found for ${service}/${functionName} at ${dir}, and stack ` +
        `"${stack}" may not deploy a placeholder in its place. Run "cd backend && npm run bundle" first.`,
    );
  }
  pulumi.log.warn(
    `lambdaCode: no bundle found for ${service}/${functionName} at ${dir} — ` +
      `deploying the fail-closed ${fallback ? "fallback" : "501 placeholder"} instead. Run "cd backend && npm run bundle" first.`,
  );
  return fallback ? fallback() : placeholderLambdaCode();
}
