import * as pulumi from "@pulumi/pulumi";

/**
 * Fail-closed 501 stub, used by lambda-code.ts's lambdaCode() helper for any
 * service/function key backend/dist doesn't have a bundle for yet.
 */
export function placeholderLambdaCode(): pulumi.asset.Archive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.StringAsset(
      "exports.handler = async () => ({ statusCode: 501, body: JSON.stringify({ type: 'about:blank', title: 'Not Implemented', status: 501 }) });",
    ),
  });
}
