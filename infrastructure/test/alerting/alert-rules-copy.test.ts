import { beforeEach, describe, expect, it } from "vitest";
import { AlertRulesCopy } from "../../components/alerting/alert-rules-copy";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  alarmByName,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "./mock-harness";

const FN = "boxalarm-dev-alerting-alert-rules-copy-consumer";
const PAGE = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

beforeEach(() => {
  installMocks();
});

async function build(): Promise<void> {
  new AlertRulesCopy("alert-rules-copy", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    busName: "boxalarm-dev-platform-bus",
    pageTopicArn: PAGE,
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
}

// Design review M1: the ALERT_RULES projection into the alerting table.
describe("AlertRulesCopy (ALERT_RULES -> ALERT_RULES_COPY)", { timeout: 30_000 }, () => {
  it("routes only platform-service ALERT_RULES config updates to the consumer queue", async () => {
    await build();
    const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-alert-rules-copy",
    );
    expect(JSON.parse(rule?.inputs.eventPattern as string)).toEqual({
      source: ["platform-service"],
      "detail-type": ["platform.config.updated"],
      detail: { payload: { configType: ["ALERT_RULES"] } },
    });
  });

  it("writes only the ALERT_RULES partition of the alerting table, under the alerting boundary", async () => {
    await build();
    const statements = statementsForRole(FN);
    expect(isGranted(statements, "dynamodb:PutItem", TABLE_ARN)).toBe(true);
    const write = statements.find((s) => s.Sid === "AlertRulesCopyWrite");
    expect(write?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#ALERT_RULES"] },
    });
    expect(isGranted(statements, "dynamodb:GetItem", (r) => r.includes("platform"))).toBe(false);
    expect(lambdaEnv(FN)).toMatchObject({ ALERTING_TABLE_NAME: "boxalarm-dev-alerting-table" });
    const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === FN);
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("pages when a rules change dead-letters", async () => {
    await build();
    expect(
      alarmByName("boxalarm-dev-alerting-alert-rules-copy-dlq-not-empty").inputs.alarmActions,
    ).toEqual([PAGE]);
  });
});
