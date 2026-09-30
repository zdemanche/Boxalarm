import { beforeAll, describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import {
  ACCOUNT_ID,
  REGION,
  installMocks,
  resourcesOfType,
  settle,
  type MockedResource,
  type PolicyStatement,
} from "../alerting/mock-harness";

const ruleArn = (ruleName: string) => `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${ruleName}`;
const queueArn = (queueName: string) => `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${queueName}`;

function policyStatements(policy: MockedResource): PolicyStatement[] {
  return (JSON.parse(policy.inputs.policy as string) as { Statement: PolicyStatement[] }).Statement;
}

function eventBridgeStatements(): { queue: string; sourceArn: unknown }[] {
  return resourcesOfType("aws:sqs/queuePolicy:QueuePolicy").flatMap((policy) =>
    policyStatements(policy)
      .filter(
        (s) =>
          (s as unknown as { Principal?: { Service?: string } }).Principal?.Service ===
          "events.amazonaws.com",
      )
      .map((s) => ({
        queue: s.Resource as string,
        sourceArn: s.Condition?.ArnEquals?.["aws:SourceArn"],
      })),
  );
}

describe("QueueConsumer — EventBridge delivery (deploy-readiness C1)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    installMocks();
    const { QueueConsumer } = await import("../../components/messaging/queue-consumer");
    const role = new aws.iam.Role("consumer-role", { assumeRolePolicy: "{}" });
    const fn = new aws.lambda.Function("consumer-fn", {
      name: "consumer-fn",
      role: role.arn,
      runtime: "nodejs22.x",
      handler: "index.handler",
    });
    new QueueConsumer("test-consumer", {
      env: "dev",
      busName: "boxalarm-dev-platform-bus",
      ruleName: "boxalarm-dev-test-rule",
      eventPattern: JSON.stringify({ "detail-type": ["personnel.member.updated"] }),
      queueName: "boxalarm-dev-test-queue",
      lambda: fn,
      lambdaRole: role,
    });
    await settle();
  });

  it("conditions the main queue AND the DLQ send permission on the RULE ARN, not the bus ARN", () => {
    const statements = eventBridgeStatements();
    expect(statements).toEqual(
      expect.arrayContaining([
        {
          queue: queueArn("boxalarm-dev-test-queue"),
          sourceArn: ruleArn("boxalarm-dev-test-rule"),
        },
        {
          queue: queueArn("boxalarm-dev-test-queue-dlq"),
          sourceArn: ruleArn("boxalarm-dev-test-rule"),
        },
      ]),
    );
    expect(JSON.stringify(statements)).not.toContain(":event-bus/");
  });

  it("dead-letters undeliverable events into the consumer DLQ", () => {
    const [target] = resourcesOfType("aws:cloudwatch/eventTarget:EventTarget");
    expect(target!.inputs.deadLetterConfig).toEqual({
      arn: queueArn("boxalarm-dev-test-queue-dlq"),
    });
  });

  it("alarms on the rule's FailedInvocations", () => {
    const alarm = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm").find(
      (a) => a.inputs.metricName === "FailedInvocations",
    );
    expect(alarm?.inputs).toMatchObject({
      name: "boxalarm-dev-test-rule-failed-invocations",
      namespace: "AWS/Events",
      dimensions: { RuleName: "boxalarm-dev-test-rule", EventBusName: "boxalarm-dev-platform-bus" },
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
    });
  });
});
