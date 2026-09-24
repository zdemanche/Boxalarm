import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

interface CapturedAlarm {
  name: string;
  namespace: string;
  metricName: string;
  dimensions: Record<string, unknown>;
  alarmActions: string[];
}

let alarms: CapturedAlarm[];
let subscriptions: { protocol: string; endpoint: string; topic: string }[];

function mockResources() {
  alarms = [];
  subscriptions = [];
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sns/topic:Topic") {
        state.arn = `arn:aws:sns:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sns/topicSubscription:TopicSubscription") {
        subscriptions.push({
          protocol: args.inputs.protocol as string,
          endpoint: args.inputs.endpoint as string,
          topic: args.inputs.topic as string,
        });
      }
      if (args.type === "aws:cloudwatch/metricAlarm:MetricAlarm") {
        alarms.push({
          name: args.inputs.name as string,
          namespace: args.inputs.namespace as string,
          metricName: args.inputs.metricName as string,
          dimensions: (args.inputs.dimensions as Record<string, unknown>) ?? {},
          alarmActions: args.inputs.alarmActions as string[],
        });
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
}

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function buildAlarms(pageEmail?: string) {
  const { MessagingAlerting } = await import("../../components/alerting/messaging-alerting");
  const { AlertingAlarms } = await import("../../components/alerting/alarms");

  const messaging = new MessagingAlerting("messaging", { env: "dev" });
  const memberUpdatedDlq = new (await import("@pulumi/aws")).sqs.Queue("member-updated-dlq", {
    name: "boxalarm-dev-alerting-member-updated-dlq",
  });

  const alerting = new AlertingAlarms("alerting-alarms", {
    env: "dev",
    channelQueues: messaging.channelQueues,
    fanOutFunctionName: "boxalarm-dev-alerting-fan-out",
    escalationFunctionName: "boxalarm-dev-alerting-escalation",
    memberUpdatedDlq,
    pageEmail,
  });

  await resolve(alerting.pageTopic.arn);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return alerting;
}

describe("AlertingAlarms", () => {
  beforeEach(() => mockResources());

  it("subscribes the configured page email to the alerting-page topic", async () => {
    const alerting = await buildAlarms("oncall@example.com");
    const topicArn = await resolve(alerting.pageTopic.arn);
    const emailSubscriptions = subscriptions.filter((s) => s.protocol === "email");

    expect(emailSubscriptions).toHaveLength(1);
    expect(emailSubscriptions[0]!.endpoint).toBe("oncall@example.com");
    expect(emailSubscriptions[0]!.topic).toBe(topicArn);
  });

  it("creates no page-topic subscription when pageEmail is unset (documented placeholder, not silent)", async () => {
    await buildAlarms(undefined);
    expect(subscriptions.filter((s) => s.protocol === "email")).toHaveLength(0);
  });

  it("alarms on fan-out Errors and IteratorAge", async () => {
    await buildAlarms("oncall@example.com");
    const errors = alarms.find(
      (a) =>
        a.namespace === "AWS/Lambda" && a.metricName === "Errors" && a.name.includes("fan-out"),
    );
    const iteratorAge = alarms.find(
      (a) =>
        a.namespace === "AWS/Lambda" &&
        a.metricName === "IteratorAge" &&
        a.name.includes("fan-out"),
    );
    expect(errors).toBeDefined();
    expect(errors!.dimensions.FunctionName).toBe("boxalarm-dev-alerting-fan-out");
    expect(iteratorAge).toBeDefined();
    expect(iteratorAge!.dimensions.FunctionName).toBe("boxalarm-dev-alerting-fan-out");
  });

  it("alarms on escalation Errors and Throttles", async () => {
    await buildAlarms("oncall@example.com");
    const errors = alarms.find(
      (a) =>
        a.namespace === "AWS/Lambda" && a.metricName === "Errors" && a.name.includes("escalation"),
    );
    const throttles = alarms.find(
      (a) =>
        a.namespace === "AWS/Lambda" &&
        a.metricName === "Throttles" &&
        a.name.includes("escalation"),
    );
    expect(errors).toBeDefined();
    expect(errors!.dimensions.FunctionName).toBe("boxalarm-dev-alerting-escalation");
    expect(throttles).toBeDefined();
    expect(throttles!.dimensions.FunctionName).toBe("boxalarm-dev-alerting-escalation");
  });

  it("alarms on each channel queue's oldest-message age", async () => {
    await buildAlarms("oncall@example.com");
    for (const channel of ["push", "sms", "voice"]) {
      const alarm = alarms.find(
        (a) => a.metricName === "ApproximateAgeOfOldestMessage" && a.name.includes(channel),
      );
      expect(alarm).toBeDefined();
    }
  });

  it("alarms on the member-updated DLQ", async () => {
    await buildAlarms("oncall@example.com");
    const alarm = alarms.find(
      (a) =>
        a.metricName === "ApproximateNumberOfMessagesVisible" && a.name.includes("member-updated"),
    );
    expect(alarm).toBeDefined();
  });

  it("every alarm pages through the alerting-page topic", async () => {
    const alerting = await buildAlarms("oncall@example.com");
    const topicArn = await resolve(alerting.pageTopic.arn);
    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      expect(alarm.alarmActions).toEqual([topicArn]);
    }
  });
});
