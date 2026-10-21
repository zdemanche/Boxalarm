import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { EligibilityStaleness } from "../../components/alerting/staleness";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  alarmByName,
  installMocks,
  resourcesOfType,
  settle,
} from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

beforeEach(() => {
  installMocks();
});

async function build() {
  const staleness = new EligibilityStaleness("staleness", {
    env: "dev",
    deptId: "nichols-fd",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    pageTopicArn: PAGE_TOPIC_ARN,
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    permissionsBoundaryArn: BOUNDARY_ARN,
    eligibilityFeedQueueNames: {
      "member-updated": "boxalarm-dev-alerting-member-updated-queue",
      "availability-snapshot": "boxalarm-dev-availability-snapshot-queue",
      "eligibility-changed": "boxalarm-dev-eligibility-changed-snapshot-queue",
    },
  });
  await settle();
  return staleness;
}

describe("EligibilityStaleness", { timeout: 30_000 }, () => {
  it("puts the scheduler role under the alerting-plane permissions boundary", async () => {
    await build();
    const role = resourcesOfType("aws:iam/role:Role").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-staleness-scheduler",
    );
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("keeps SnapshotStale dashboard-only: a quiet department must not page", async () => {
    await build();
    const alarm = alarmByName("boxalarm-dev-alerting-eligibility-snapshot-stale");
    expect(alarm.inputs.namespace).toBe("Boxalarm/AlertingEligibility");
    expect(alarm.inputs.alarmActions).toBeUndefined();
  });

  it.each([
    ["member-updated", "boxalarm-dev-alerting-member-updated-queue"],
    ["availability-snapshot", "boxalarm-dev-availability-snapshot-queue"],
    ["eligibility-changed", "boxalarm-dev-eligibility-changed-snapshot-queue"],
  ])("pages on the age of the oldest message in the %s queue", async (feed, queueName) => {
    await build();
    const alarm = alarmByName(`boxalarm-dev-alerting-eligibility-${feed}-queue-age`).inputs;
    expect(alarm.namespace).toBe("AWS/SQS");
    expect(alarm.metricName).toBe("ApproximateAgeOfOldestMessage");
    expect(alarm.dimensions).toEqual({ QueueName: queueName });
    expect(alarm.statistic).toBe("Maximum");
    expect(alarm.period).toBe(60);
    expect(alarm.evaluationPeriods).toBeGreaterThanOrEqual(2);
    expect(alarm.threshold).toBeGreaterThanOrEqual(120);
    expect(alarm.threshold).toBeLessThanOrEqual(300);
    expect(alarm.treatMissingData).toBe("notBreaching");
    expect(alarm.alarmActions).toEqual([PAGE_TOPIC_ARN]);
  });

  it("pages on the staleness Lambda's own Errors (the stale alarm goes silent if it throws)", async () => {
    await build();
    const alarm = alarmByName("boxalarm-dev-alerting-eligibility-staleness-check-errors").inputs;
    expect(alarm.namespace).toBe("AWS/Lambda");
    expect(alarm.metricName).toBe("Errors");
    expect(alarm.dimensions).toEqual({
      FunctionName: "boxalarm-dev-alerting-eligibility-staleness-check",
    });
    expect(alarm.alarmActions).toEqual([PAGE_TOPIC_ARN]);
  });
});
