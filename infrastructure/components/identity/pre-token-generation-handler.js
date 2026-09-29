// Cognito Pre Token Generation trigger, Lambda version V2_0.
//
// Custom attributes are NOT included on the access token by default — only on the ID
// token — so without this, boxalarm-backend's authorizer (which reads custom:deptId
// from the verified ACCESS token, never the ID token: tenancy must hold for
// server-to-server API calls, which carry the access token) would deny every request.
// See #180.
//
// Deliberately does not throw or deny sign-in when custom:deptId is missing/blank:
// that would block login entirely. The authorizer is where "no claim => denied" is
// enforced, scoped to API access rather than authentication.
//
// Inactive members (review C1): this trigger runs on every sign-in AND every refresh-token
// redemption, so it is the one place that can refuse to mint a token for a member whose row
// says LOA or RETIRED. Session revocation also disables the Cognito login; this check is
// independent of that call succeeding (a DLQ'd revocation still cannot be used to sign in or
// refresh). Throwing makes Cognito fail the token request.
//
// It FAILS OPEN on a lookup error or timeout, on purpose: the same trigger sits under every
// responder's silent refresh, and "a login prompt on the alert path is an alerting failure"
// (CLAUDE.md). A platform-table outage must not sign the department out; the disabled login
// and the authorizer's revocation check still hold for revoked members while it lasts.
const INACTIVE_STATUSES = new Set(["LOA", "RETIRED"]);

let cachedClient;

// Loaded lazily: the Lambda Node.js runtime ships the v3 SDK, but this package does not
// depend on it, so a top-level import would break every test that imports this file.
function sdk() {
  return import("@aws-sdk/client-dynamodb");
}

async function getClient() {
  const { DynamoDBClient } = await sdk();
  // One attempt with a short timeout: Cognito gives the whole trigger 5 s, and the answer
  // on a slow table is "allow" anyway.
  cachedClient ??= new DynamoDBClient({
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 300, requestTimeout: 800 },
  });
  return cachedClient;
}

async function readMemberStatusFromTable(tableName, deptId, memberId) {
  const { GetItemCommand } = await sdk();
  const client = await getClient();
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: `DEPT#${deptId}#MEMBER#${memberId}` }, sk: { S: "METADATA" } },
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  return result.Item?.status?.S;
}

function createHandler(deps) {
  return async (event) => {
    const attributes = event.request.userAttributes;
    const deptId = attributes["custom:deptId"];
    const hasDept = typeof deptId === "string" && deptId.trim().length > 0;

    const memberId = attributes.sub;
    // '#' is the partition-key delimiter; a value carrying it cannot name a member row.
    if (hasDept && typeof memberId === "string" && !deptId.includes("#") && deps.tableName) {
      let status;
      try {
        status = await deps.readMemberStatus(deps.tableName, deptId, memberId);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "preTokenGeneration.statusLookupFailed",
            reason: error instanceof Error ? error.constructor.name : "UnknownError",
            message: error instanceof Error ? error.message : undefined,
            triggerSource: event.triggerSource,
          }),
        );
      }
      if (status !== undefined && INACTIVE_STATUSES.has(status)) {
        console.error(
          JSON.stringify({
            event: "preTokenGeneration.inactiveMemberRefused",
            memberId,
            status,
            triggerSource: event.triggerSource,
          }),
        );
        throw new Error("Member is not active");
      }
    }

    if (hasDept) {
      event.response.claimsAndScopeOverrideDetails = {
        accessTokenGeneration: {
          claimsToAddOrOverride: { "custom:deptId": deptId },
        },
      };
    }
    return event;
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler({
  tableName: process.env.PLATFORM_TABLE_NAME,
  readMemberStatus: readMemberStatusFromTable,
});
