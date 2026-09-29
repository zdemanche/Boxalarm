import { beforeEach, describe, expect, it } from "vitest";
import { HttpApi } from "../../components/api/http-api";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { RoutesOps } from "../../components/alerting/routes-ops";
import {
  STACK_CONFIG,
  TABLE_ARN,
  installMocks,
  isGranted,
  settle,
  statementsForRole,
} from "./mock-harness";

const SELF_TEST_GET = "boxalarm-dev-alerting-self-test-get";

beforeEach(() => {
  installMocks(STACK_CONFIG);
});

async function build(): Promise<void> {
  const platformLogGroup = new ServiceLogGroup("platform-lg", {
    env: "dev",
    serviceName: "platform-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup,
  });
  new RoutesOps("routes-ops", {
    env: "dev",
    httpApi,
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    policyStoreId: "policy-store-id",
  });
  await settle();
}

// Design review C3: the self-test result is decided from the channel workers' send guards
// when the member polls - the route reads them and records the verdict.
describe("self-test GET route IAM (receipt-based PASS)", { timeout: 30_000 }, () => {
  it.each(["dynamodb:GetItem", "dynamodb:UpdateItem"])(
    "grants %s on the alerting table",
    async (action) => {
      await build();
      expect(isGranted(statementsForRole(SELF_TEST_GET), action, TABLE_ARN)).toBe(true);
    },
  );

  it("still holds no write beyond UpdateItem (no Put, no Delete)", async () => {
    await build();
    const statements = statementsForRole(SELF_TEST_GET);
    expect(isGranted(statements, "dynamodb:PutItem", TABLE_ARN)).toBe(false);
    expect(isGranted(statements, "dynamodb:DeleteItem", TABLE_ARN)).toBe(false);
  });
});
