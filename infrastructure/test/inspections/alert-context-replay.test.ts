import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  ALERT_CONTEXT_REPLAY_TIMEOUT_SECONDS,
  AlertContextReplay,
} from "../../components/inspections/alert-context-replay";
import {
  ACCOUNT_ID,
  REGION,
  installMocks,
  isGranted,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const FN = "boxalarm-dev-inspections-alert-context-replay";

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("inspections-lg", {
    env: "dev",
    serviceName: "inspections-service",
  });
  new AlertContextReplay("replay", {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    platformTableArn: pulumi.output(TABLE),
    logGroup,
  });
  await settle();
}

describe("AlertContextReplay (post-deploy backfill of the alerting pre-plan/hydrant copies)", () => {
  it("is an invoke-only Lambda: no route, no schedule, one run at a time", async () => {
    await build();
    const fn = lambdaByName(FN);
    expect(fn.inputs.reservedConcurrentExecutions).toBe(1);
    expect(fn.inputs.timeout).toBe(ALERT_CONTEXT_REPLAY_TIMEOUT_SECONDS);
    expect(lambdaEnv(FN)).toEqual(
      expect.objectContaining({ PLATFORM_TABLE_NAME: "boxalarm-dev-platform-service" }),
    );
    expect(resourcesOfType("aws:apigatewayv2/route:Route")).toEqual([]);
    expect(resourcesOfType("aws:scheduler/schedule:Schedule")).toEqual([]);
  });

  it("can read the list partitions and rows and emit outbox rows, but never update or delete", async () => {
    await build();
    const statements = statementsForRole(FN);
    expect(isGranted(statements, "dynamodb:Query", `${TABLE}/index/GSI3`)).toBe(true);
    for (const action of [
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:PutItem",
    ]) {
      expect(isGranted(statements, action, TABLE)).toBe(true);
    }
    for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"]) {
      expect(isGranted(statements, action, () => true)).toBe(false);
    }
    expect(isGranted(statements, "dynamodb:PutItem", (r) => r.includes("alerting"))).toBe(false);
  });
});
