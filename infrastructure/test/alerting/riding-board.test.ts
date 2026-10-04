import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PlatformBus } from "../../components/messaging/platform-bus";
import { RidingBoard } from "../../components/alerting/riding-board";
import {
  ACCOUNT_ID,
  CMK_ARN,
  BOUNDARY_ARN,
  REGION,
  esmFor,
  installMocks,
  isGranted,
  lambdaByName,
  resourcesOfType,
  settle,
  statementsForRole,
} from "./mock-harness";

const PLATFORM_TABLE_ARN =
  "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-platform-table";
const GSI3_ARN = `${PLATFORM_TABLE_ARN}/index/GSI3`;
const ALERTING_TABLE_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-alerting-table`;
const PAGE_TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-alerting-page`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const platformLogGroup = new ServiceLogGroup("platform-lg", {
    env: "dev",
    serviceName: "platform-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    platformTableName: "platform-table",
    platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
    allowedClientIds: ["client-1"],
    platformLogGroup,
  });
  const platformBus = new PlatformBus("platform-bus", { env: "dev" });
  const ridingBoard = new RidingBoard("riding-board", {
    env: "dev",
    httpApi,
    // An Output, as index.ts passes it — proves the index ARN is resolved, not stringified.
    platformTableArn: pulumi.output(PLATFORM_TABLE_ARN),
    platformTableName: "boxalarm-dev-platform-table",
    logGroup: new ServiceLogGroup("apparatus-lg", { env: "dev", serviceName: "apparatus-service" }),
    policyStoreId: "policy-store-id",
    platformBus,
    alertingTableArn: pulumi.output(ALERTING_TABLE_ARN),
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingCmkArn: CMK_ARN,
    alertingLogGroup: new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    }),
    alertingPermissionsBoundaryArn: BOUNDARY_ARN,
    pageTopicArn: PAGE_TOPIC_ARN,
  });
  await settle();
  return ridingBoard;
}

describe(
  "RidingBoard IAM matches apparatus-service ridingBoard's DynamoDB calls",
  { timeout: 30_000 },
  () => {
    it("GET can Query GSI3 (listApparatusForBoard) plus Get/Query the table", async () => {
      await build();
      const statements = statementsForRole("boxalarm-dev-apparatus-riding-board-get");
      expect(isGranted(statements, "dynamodb:Query", GSI3_ARN)).toBe(true);
      expect(isGranted(statements, "dynamodb:GetItem", PLATFORM_TABLE_ARN)).toBe(true);
      expect(isGranted(statements, "dynamodb:Query", PLATFORM_TABLE_ARN)).toBe(true);
      expect(isGranted(statements, "dynamodb:UpdateItem", PLATFORM_TABLE_ARN)).toBe(false);
    });

    it("assign can Query GSI3 (findApparatusItem) and perform every item of assignSeat's transaction", async () => {
      await build();
      const statements = statementsForRole("boxalarm-dev-apparatus-riding-board-assign");
      expect(isGranted(statements, "dynamodb:Query", GSI3_ARN)).toBe(true);
      for (const action of [
        "dynamodb:GetItem",
        "dynamodb:ConditionCheckItem",
        "dynamodb:UpdateItem",
        "dynamodb:PutItem",
      ]) {
        expect(isGranted(statements, action, PLATFORM_TABLE_ARN), action).toBe(true);
      }
    });

    // #257 sweep: assignSeat's UpdateItem makes this a mutating role.
    it("assign carries the audit-row deny on its UpdateItem grant", async () => {
      await build();
      const statements = statementsForRole("boxalarm-dev-apparatus-riding-board-assign");
      const deny = statements.find((st) => st.Sid === "DenyAuditMutations");
      expect(deny?.Effect).toBe("Deny");
    });
  },
);

// #235: apparatus.serviceStatus.changed -> alerting-owned copy.
describe("RidingBoard apparatus-status-changed bridge (#235)", { timeout: 30_000 }, () => {
  it("grants the copy consumer role only the alerting table, never platform-service", async () => {
    await build();
    const statements = statementsForRole("boxalarm-dev-alerting-apparatus-status-changed-consumer");
    expect(isGranted(statements, "dynamodb:PutItem", ALERTING_TABLE_ARN)).toBe(true);
    expect(isGranted(statements, "dynamodb:UpdateItem", ALERTING_TABLE_ARN)).toBe(true);
    expect(isGranted(statements, "dynamodb:PutItem", PLATFORM_TABLE_ARN)).toBe(false);
    expect(isGranted(statements, "dynamodb:GetItem", PLATFORM_TABLE_ARN)).toBe(false);
  });

  it("puts the copy consumer role under the alerting-plane permissions boundary", async () => {
    await build();
    const role = resourcesOfType("aws:iam/role:Role").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-apparatus-status-changed-consumer",
    );
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("routes only apparatus-service's apparatus.serviceStatus.changed to the copy queue", async () => {
    await build();
    const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
      (r) => r.inputs.name === "boxalarm-dev-apparatus-status-changed",
    );
    expect(rule).toBeDefined();
    const pattern = JSON.parse(rule!.inputs.eventPattern as string);
    expect(pattern.source).toEqual(["apparatus-service"]);
    expect(pattern["detail-type"]).toEqual(["apparatus.serviceStatus.changed"]);
  });

  it("reserves its own concurrency pool, distinct from fan-out's", async () => {
    await build();
    const fn = lambdaByName("boxalarm-dev-alerting-apparatus-status-changed-consumer");
    expect(fn.inputs.reservedConcurrentExecutions).toBe(5);
  });

  it("caps the queue's event source mapping concurrency, separate from the main fan-out", async () => {
    await build();
    const esm = esmFor("boxalarm-dev-alerting-apparatus-status-changed-consumer");
    expect(
      (esm.inputs.scalingConfig as { maximumConcurrency?: number } | undefined)?.maximumConcurrency,
    ).toBe(5);
  });
});
