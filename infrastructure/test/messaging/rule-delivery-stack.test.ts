import { beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNT_ID,
  REGION,
  STACK_CONFIG,
  installMocks,
  resourcesOfType,
  settleStack,
  type MockedResource,
  type PolicyStatement,
} from "../alerting/mock-harness";

const ruleArn = (ruleName: string) => `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${ruleName}`;

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

describe(
  "full stack: every EventBridge delivery can succeed and cannot fail silently",
  {
    timeout: 120_000,
  },
  () => {
    beforeAll(async () => {
      installMocks(STACK_CONFIG);
      await import("../../index");
      await settleStack();
    }, 120_000);

    it("captures every rule and target (settleStack does not stop early)", () => {
      const rules = resourcesOfType("aws:cloudwatch/eventRule:EventRule");
      expect(rules.length).toBeGreaterThanOrEqual(20);
      expect(resourcesOfType("aws:cloudwatch/eventTarget:EventTarget")).toHaveLength(rules.length);
    });

    it("every SQS permission for events.amazonaws.com names the ARN of a rule that targets that queue", () => {
      const targets = resourcesOfType("aws:cloudwatch/eventTarget:EventTarget");
      const rulesDelivering = (queue: string) =>
        targets
          .filter(
            (t) =>
              t.inputs.arn === queue ||
              (t.inputs.deadLetterConfig as { arn?: string } | undefined)?.arn === queue,
          )
          .map((t) => ruleArn(t.inputs.rule as string));

      const statements = eventBridgeStatements();
      expect(statements.length).toBeGreaterThanOrEqual(19);
      const wrong = statements.filter(
        (s) => !rulesDelivering(s.queue).includes(s.sourceArn as string),
      );
      expect(wrong).toEqual([]);
    });

    it("every Lambda permission for events.amazonaws.com names a rule ARN", () => {
      const permissions = resourcesOfType("aws:lambda/permission:Permission").filter(
        (p) => p.inputs.principal === "events.amazonaws.com",
      );
      const ruleArns = new Set(
        resourcesOfType("aws:cloudwatch/eventRule:EventRule").map((r) =>
          ruleArn(r.inputs.name as string),
        ),
      );
      expect(permissions.filter((p) => !ruleArns.has(p.inputs.sourceArn as string))).toEqual([]);
    });

    it("every rule target has a dead-letter queue the rule may write to", () => {
      const targets = resourcesOfType("aws:cloudwatch/eventTarget:EventTarget");
      const missing = targets.filter((t) => t.inputs.deadLetterConfig === undefined);
      expect(missing.map((t) => t.inputs.rule)).toEqual([]);

      const writable = new Set(eventBridgeStatements().map((s) => `${s.queue}|${s.sourceArn}`));
      const unwritable = targets.filter(
        (t) =>
          !writable.has(
            `${(t.inputs.deadLetterConfig as { arn: string }).arn}|${ruleArn(t.inputs.rule as string)}`,
          ),
      );
      expect(unwritable.map((t) => t.inputs.rule)).toEqual([]);
    });

    it("every rule has a FailedInvocations alarm", () => {
      const watched = new Set(
        resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm")
          .filter((a) => a.inputs.metricName === "FailedInvocations")
          .map((a) => (a.inputs.dimensions as { RuleName: string }).RuleName),
      );
      const unwatched = resourcesOfType("aws:cloudwatch/eventRule:EventRule")
        .map((r) => r.inputs.name as string)
        .filter((name) => !watched.has(name));
      expect(unwatched).toEqual([]);
    });
  },
);
