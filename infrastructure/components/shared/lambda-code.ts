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
 */
export function lambdaCode(service: string, functionName: string): pulumi.asset.Archive {
  const dir = path.join(BACKEND_DIST_ROOT, service, functionName);
  if (fs.existsSync(path.join(dir, "index.mjs"))) {
    return new pulumi.asset.FileArchive(dir);
  }
  return placeholderLambdaCode();
}
