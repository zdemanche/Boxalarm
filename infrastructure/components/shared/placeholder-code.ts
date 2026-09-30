import * as pulumi from "@pulumi/pulumi";

/**
 * Fail-closed stub, used by lambda-code.ts's lambdaCode() helper for any service/function key
 * backend/dist has no bundle for (dev stacks and unit tests only - every other stack refuses to
 * deploy without the bundle).
 *
 * An HTTP API request gets a 501 problem. Every other trigger - a DynamoDB stream, an SQS
 * queue, EventBridge Scheduler, an async invoke - gets a thrown error: for those a returned
 * value is SUCCESS, so the old stub's `{ statusCode: 501 }` checkpointed the fan-out stream past
 * the dispatch and deleted pages off the channel queues with nobody paged (design review M5).
 * Thrown, they retry, reach their DLQ / on-failure destination, and page on-call.
 */
export const PLACEHOLDER_SOURCE = [
  "exports.handler = async (event) => {",
  "  const isHttp = !!(event && event.requestContext && (event.requestContext.http || event.routeKey));",
  "  if (isHttp) {",
  "    return { statusCode: 501, headers: { 'content-type': 'application/problem+json' }, body: JSON.stringify({ type: 'about:blank', title: 'Not Implemented', status: 501 }) };",
  "  }",
  "  throw new Error('Boxalarm placeholder Lambda: no backend bundle was deployed for this function. Run `cd backend && npm run bundle` and redeploy.');",
  "};",
].join("\n");

export function placeholderLambdaCode(): pulumi.asset.Archive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.StringAsset(PLACEHOLDER_SOURCE),
  });
}
