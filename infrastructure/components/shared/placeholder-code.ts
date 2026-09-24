import * as pulumi from "@pulumi/pulumi";

export const PLACEHOLDER_LAMBDA_HANDLER = "index.handler";

// TODO: E2-S1-INFRA — no backend Lambda artifact pipeline (code-bucket component,
// CI bundling of backend/src/services/**) exists yet in this repo. Every new
// service Lambda in this batch ships with this stub so the surrounding infra
// (routes, IAM, queues, alarms) is provisionable and testable now; the real
// handler code swaps in once that pipeline lands.
export function placeholderLambdaCode(): pulumi.asset.Archive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.StringAsset(
      "exports.handler = async () => ({ statusCode: 501, body: JSON.stringify({ type: 'about:blank', title: 'Not Implemented', status: 501 }) });",
    ),
  });
}
