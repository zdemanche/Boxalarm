import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { AlertingCanary } from "../../components/alerting/canary";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  installMocks,
  isGranted,
  settle,
  statementsForRole,
} from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

beforeEach(() => {
  installMocks({ "boxalarm-infra:canaryMemberId": "test-canary-member" });
});

async function build() {
  const canary = new AlertingCanary("canary", {
    env: "dev",
    deptId: "nichols-fd",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    pageTopicArn: PAGE_TOPIC_ARN,
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return canary;
}

describe(
  "AlertingCanary IAM covers every DynamoDB call the canary Lambda makes",
  { timeout: 30_000 },
  () => {
    // canary/handler.ts → canaryRunRepository (Get/Put/Delete), selfTestRunRepository
    // (Get/Put), dispatches/repository.createManualDispatch (TransactWriteCommand of Puts).
    const REPOSITORY_OPERATIONS = {
      "getCanaryPointer / getSelfTestRun": "dynamodb:GetItem",
      "setCanaryPointer / putCanaryRun / upsertSelfTestRun / acquireSelfTestCooldown":
        "dynamodb:PutItem",
      clearCanaryPointer: "dynamodb:DeleteItem",
      "createManualDispatch (transaction)": "dynamodb:TransactWriteItems",
      "createManualDispatch (transaction Put items)": "dynamodb:PutItem",
    } as const;

    for (const [operation, action] of Object.entries(REPOSITORY_OPERATIONS)) {
      it(`grants ${action} on the alerting table for ${operation}`, async () => {
        await build();
        const statements = statementsForRole("boxalarm-dev-alerting-canary");
        expect(isGranted(statements, action, TABLE_ARN)).toBe(true);
      });
    }
  },
);
