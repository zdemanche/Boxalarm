import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHEDULING_LAMBDAS,
  buildSchedulingChain,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  statementsForRole,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

describe(
  "Escalation schedule group — IAM scope and CreateSchedule GroupName agree",
  { timeout: 30_000 },
  () => {
    it.each(SCHEDULING_LAMBDAS)(
      "%s is told the dedicated group and may create schedules only inside it",
      async (functionName) => {
        await buildSchedulingChain();
        const [group] = resourcesOfType("aws:scheduler/scheduleGroup:ScheduleGroup");
        const groupName = group!.inputs.name as string;
        expect(groupName).toBe("boxalarm-dev-alerting-escalation");

        expect(lambdaEnv(functionName).ESCALATION_SCHEDULE_GROUP_NAME).toBe(groupName);

        const statements = statementsForRole(functionName);
        expect(
          isGranted(
            statements,
            "scheduler:CreateSchedule",
            `arn:aws:scheduler:us-east-1:123456789012:schedule/${groupName}/*`,
          ),
        ).toBe(true);
        // Least privilege: nothing grants the implicit `default` group.
        expect(
          isGranted(statements, "scheduler:CreateSchedule", (r) => r.includes("schedule/default/")),
        ).toBe(false);
      },
    );
  },
);

// Review MAJOR-2: a failed async evaluation was retried twice and then discarded, yet the
// re-publish of unsent pages and the mutual-aid rethrow depend on that retry landing.
describe(
  "Escalation and tone evaluator — failed async invocations are kept",
  { timeout: 30_000 },
  () => {
    it.each([
      ["boxalarm-dev-alerting-escalation", "escalation"],
      ["boxalarm-dev-alerting-tone-evaluator", "tone-evaluator"],
    ])("%s sends exhausted events to the escalation on-failure queue", async (functionName) => {
      await buildSchedulingChain();
      const [queue] = resourcesOfType("aws:sqs/queue:Queue").filter(
        (q) => q.inputs.name === "boxalarm-dev-alerting-escalation-onfailure",
      );
      expect(queue?.inputs.sqsManagedSseEnabled).toBe(true);
      const queueArn =
        "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-escalation-onfailure";

      const config = resourcesOfType(
        "aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig",
      ).find((c) => c.inputs.functionName === functionName);
      expect(config?.inputs).toMatchObject({
        maximumRetryAttempts: 2,
        maximumEventAgeInSeconds: 3600,
        destinationConfig: { onFailure: { destination: queueArn } },
      });
      expect(isGranted(statementsForRole(functionName), "sqs:SendMessage", queueArn)).toBe(true);
    });
  },
);

const SCHEDULE_DLQ_ARN = "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-schedule-dlq";
const SCHEDULER_ROLE_ARN =
  "arn:aws:iam::123456789012:role/boxalarm-dev-alerting-escalation-scheduler";

describe("Escalation schedule DLQ (runtime tone and voice schedules)", { timeout: 30_000 }, () => {
  it.each(SCHEDULING_LAMBDAS)(
    "%s is told the DLQ as ESCALATION_SCHEDULE_DLQ_ARN (scheduleEscalation.ts contract)",
    async (functionName) => {
      await buildSchedulingChain();
      expect(lambdaEnv(functionName).ESCALATION_SCHEDULE_DLQ_ARN).toBe(SCHEDULE_DLQ_ARN);
    },
  );

  it("the scheduler execution role may send to it, and the queue policy admits only that role", async () => {
    await buildSchedulingChain();
    expect(
      isGranted(
        statementsForRole("boxalarm-dev-alerting-escalation-scheduler"),
        "sqs:SendMessage",
        SCHEDULE_DLQ_ARN,
      ),
    ).toBe(true);
    const policy = resourcesOfType("aws:sqs/queuePolicy:QueuePolicy").find(
      (p) => p.inputs.queueUrl === "escalation-schedule-dlq-id",
    );
    const statements = (
      JSON.parse(policy!.inputs.policy as string) as {
        Statement: { Effect: string; Principal: unknown; Action: string; Resource: string }[];
      }
    ).Statement;
    expect(statements).toEqual([
      expect.objectContaining({
        Effect: "Allow",
        Principal: { AWS: SCHEDULER_ROLE_ARN },
        Action: "sqs:SendMessage",
        Resource: SCHEDULE_DLQ_ARN,
      }),
    ]);
  });

  it("stays inside the alerting permissions boundary", async () => {
    await buildSchedulingChain();
    const role = resourcesOfType("aws:iam/role:Role").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-escalation-scheduler",
    );
    expect(role!.inputs.permissionsBoundary).toBe(
      "arn:aws:iam::123456789012:policy/boxalarm-dev-alerting-plane-boundary",
    );
  });

  it("pages alerting-page when a schedule is dead-lettered", async () => {
    await buildSchedulingChain();
    const alarm = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm").find(
      (a) => a.inputs.name === "boxalarm-dev-alerting-schedule-dlq-not-empty",
    );
    expect(alarm?.inputs).toMatchObject({
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: "boxalarm-dev-alerting-schedule-dlq" },
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      alarmActions: ["arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page"],
    });
  });
});
