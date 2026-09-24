import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

interface PolicyStatement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
}

// Keyed by the RolePolicy's Pulumi resource name (e.g. "channel-workers-push-fn-role-policy"),
// captures the raw policy JSON so each consumer's statements can be inspected independently.
let rolePolicyByName: Record<string, string>;

beforeEach(() => {
  vi.resetModules();
  rolePolicyByName = {};
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
        state.url = `https://sqs.us-east-1.amazonaws.com/123456789012/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sns/topic:Topic") {
        state.arn = `arn:aws:sns:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:scheduler/scheduleGroup:ScheduleGroup") {
        state.arn = `arn:aws:scheduler:us-east-1:123456789012:schedule-group/${args.inputs.name}`;
      }
      if (args.type === "aws:secretsmanager/secret:Secret") {
        state.arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:iam/rolePolicy:RolePolicy") {
        rolePolicyByName[args.name] = args.inputs.policy as string;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
  pulumi.runtime.setAllConfig({
    "boxalarm-infra:env": "dev",
    "boxalarm-infra:webOrigin": "https://localhost:5173",
  });
});

function statementsFor(roleResourceNameSubstring: string): PolicyStatement[] {
  const [, policyJson] =
    Object.entries(rolePolicyByName).find(([name]) => name.includes(roleResourceNameSubstring)) ??
    [];
  if (!policyJson) {
    throw new Error(
      `no RolePolicy captured matching "${roleResourceNameSubstring}"; captured: ${Object.keys(rolePolicyByName).join(", ")}`,
    );
  }
  return (JSON.parse(policyJson) as { Statement: PolicyStatement[] }).Statement;
}

function hasAction(statements: PolicyStatement[], action: string, resource: string): boolean {
  return statements.some((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    return s.Effect === "Allow" && actions.includes(action) && resources.includes(resource);
  });
}

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("alerting-plane consumer IAM: every SQS/stream consumer can read its own event source", () => {
  it("channel workers get sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes on their own queue", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { MessagingAlerting } = await import("../../components/alerting/messaging-alerting");
    const { ChannelWorkers } = await import("../../components/alerting/channel-workers");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const messaging = new MessagingAlerting("messaging", { env: "dev" });
    new ChannelWorkers("channel-workers", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      channelQueues: messaging.channelQueues,
      logGroup,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    for (const channel of ["push", "sms", "voice"] as const) {
      const queueArn = await resolve(messaging.channelQueues[channel].queue.arn);
      const statements = statementsFor(`channel-workers-${channel}-fn-role-policy`);
      for (const action of [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility",
      ]) {
        expect(hasAction(statements, action, queueArn)).toBe(true);
      }
    }
  });

  it("the member-updated consumer gets sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes on its own queue", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");
    const { PushTokens } = await import("../../components/alerting/push-tokens");

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
    const personnelLogGroup = new ServiceLogGroup("personnel-lg", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });

    const pushTokens = new PushTokens("push-tokens", {
      env: "dev",
      httpApi,
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      platformTableName: "boxalarm-dev-platform-table",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      personnelLogGroup,
      alertingLogGroup,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const queueArn = await resolve(pushTokens.memberUpdatedQueue.arn);
    const statements = statementsFor("push-tokens-member-updated-fn-role-policy");
    for (const action of [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]) {
      expect(hasAction(statements, action, queueArn)).toBe(true);
    }
  });

  it("fan-out gets dynamodb:GetRecords/GetShardIterator/DescribeStream on the alerting stream", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { FanOut } = await import("../../components/alerting/fan-out");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const streamArn =
      "arn:aws:dynamodb:us-east-1:123456789012:table/alerting/stream/2026-01-01T00:00:00.000";

    new FanOut("fan-out", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      alertingStreamArn: streamArn,
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      alertingTableCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
      logGroup,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const statements = statementsFor("fan-out-fn-role-policy");
    for (const action of [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]) {
      expect(hasAction(statements, action, streamArn)).toBe(true);
    }
    expect(hasAction(statements, "dynamodb:ListStreams", "*")).toBe(true);
  });
});
