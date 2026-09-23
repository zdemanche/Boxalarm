import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

let functionTimeoutByName: Record<string, number | undefined>;

beforeEach(() => {
  vi.resetModules();
  functionTimeoutByName = {};
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        const fnName = (args.inputs.name as string) ?? args.name;
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${fnName}`;
        state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${state.arn}/invocations`;
        functionTimeoutByName[fnName] = args.inputs.timeout as number | undefined;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sns/topic:Topic") {
        state.arn = `arn:aws:sns:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:secretsmanager/secret:Secret") {
        state.arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:scheduler/scheduleGroup:ScheduleGroup") {
        state.arn = `arn:aws:scheduler:us-east-1:123456789012:schedule-group/${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
        state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}`;
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

describe("alerting-plane Lambda timeouts (no life-safety Lambda relies on the 3s AWS default)", () => {
  it("channel workers get an explicit timeout matching the shared worker-timeout constant", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { MessagingAlerting, DEFAULT_WORKER_TIMEOUT_SECONDS } =
      await import("../../components/alerting/messaging-alerting");
    const { ChannelWorkers } = await import("../../components/alerting/channel-workers");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const messaging = new MessagingAlerting("messaging", {
      env: "dev",
      workerTimeoutSeconds: DEFAULT_WORKER_TIMEOUT_SECONDS,
    });
    new ChannelWorkers("channel-workers", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      channelQueues: messaging.channelQueues,
      logGroup,
      workerTimeoutSeconds: DEFAULT_WORKER_TIMEOUT_SECONDS,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    for (const channel of ["push", "sms", "voice"] as const) {
      const timeout = functionTimeoutByName[`boxalarm-dev-alerting-${channel}-worker`];
      expect(timeout).toBe(DEFAULT_WORKER_TIMEOUT_SECONDS);
      expect(timeout).not.toBeUndefined();
    }
  });

  it("fan-out gets an explicit timeout well above the AWS 3s default", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { FanOut } = await import("../../components/alerting/fan-out");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    new FanOut("fan-out", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      alertingStreamArn:
        "arn:aws:dynamodb:us-east-1:123456789012:table/alerting/stream/2026-01-01T00:00:00.000",
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      logGroup,
    });

    await new Promise((r) => setImmediate(r));

    const timeout = functionTimeoutByName["boxalarm-dev-alerting-fan-out"];
    expect(timeout).toBeGreaterThan(3);
  });

  it("the dispatch-ingress route gets an explicit timeout sized for its serial per-member fan-out", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");
    const { Escalation } = await import("../../components/alerting/escalation");
    const { RoutesCore } = await import("../../components/alerting/routes-core");

    const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
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
    const escalation = new Escalation("escalation", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      alertingTableName: "boxalarm-dev-alerting-table",
      logGroup: alertingLogGroup,
    });

    new RoutesCore("routes-core", {
      env: "dev",
      httpApi,
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      logGroup: alertingLogGroup,
      escalation,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const timeout = functionTimeoutByName["boxalarm-dev-alerting-dispatches-create"];
    expect(timeout).toBeGreaterThan(3);
    // API Gateway HTTP API's own integration timeout ceiling — anything above this is
    // dead time, not extra safety margin.
    expect(timeout).toBeLessThanOrEqual(29);
  });
});
