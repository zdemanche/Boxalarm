import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PlatformBus } from "../../components/messaging/platform-bus";

let recorded: { type: string; name: string; inputs: Record<string, unknown> }[] = [];

beforeEach(() => {
  recorded = [];
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      recorded.push({ type: args.type, name: args.name, inputs: args.inputs });
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      if (args.type === "aws:cloudwatch/eventBus:EventBus") {
        state.arn = `arn:aws:events:us-east-1:123456789012:event-bus/${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function settleRecorded(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("Availability — availability-changed consumer (#207)", () => {
  async function build() {
    const { Availability } = await import("../../components/personnel/availability");
    const logGroup = new ServiceLogGroup("test-availability-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const alertingLogGroup = new ServiceLogGroup("test-availability-alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const httpApi = new HttpApi("test-availability-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    const platformBus = new PlatformBus("test-availability-platform-bus", { env: "dev" });
    return new Availability("test-availability", {
      pageTopicArn: "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page",
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
      platformBus,
      alertingTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/alerting"),
      alertingCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
      alertingTableName: pulumi.output("alerting-table"),
      alertingLogGroup,
      alertingPermissionsBoundaryArn: pulumi.output(
        "arn:aws:iam::123456789012:policy/boxalarm-dev-alerting-plane-boundary",
      ),
    });
  }

  it("wires the availability-snapshot-queue with a DLQ (scope line)", async () => {
    const availability = await build();
    const [dlqName, redrive] = await Promise.all([
      resolve(availability.availabilityChangedQueueConsumer.dlq.name),
      resolve(availability.availabilityChangedQueueConsumer.queue.redrivePolicy),
    ]);
    expect(dlqName).toBe("boxalarm-dev-availability-snapshot-queue-dlq");
    const parsed = JSON.parse(redrive as string) as { maxReceiveCount: number };
    expect(parsed.maxReceiveCount).toBe(5);
  });

  it("alarms on DLQ depth above zero", async () => {
    const availability = await build();
    const [threshold, comparison] = await Promise.all([
      resolve(availability.availabilityChangedQueueConsumer.dlqDepthAlarm.threshold),
      resolve(availability.availabilityChangedQueueConsumer.dlqDepthAlarm.comparisonOperator),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
  });

  it("routes only personnel-service's personnel.availability.changed onto the queue", async () => {
    const availability = await build();
    const pattern = await resolve(availability.availabilityChangedQueueConsumer.rule.eventPattern);
    expect(JSON.parse(pattern as string)).toEqual({
      source: ["personnel-service"],
      "detail-type": ["personnel.availability.changed"],
    });
  });

  it("grants the availability-changed consumer role only the alerting table, denied on platform/incident (AC5)", async () => {
    const availability = await build();
    const policyJson = await resolve(availability.availabilityChangedConsumer.rolePolicy.policy);
    expect(policyJson).toContain("table/alerting");
    expect(policyJson).not.toContain("table/platform");
    expect(policyJson).not.toContain("table/incident");
  });

  it("grants the availability-changed consumer every item action of its transaction (Put + Update)", async () => {
    const availability = await build();
    const policyJson = await resolve(availability.availabilityChangedConsumer.rolePolicy.policy);
    const statements = (
      JSON.parse(policyJson) as { Statement: { Sid?: string; Action: string[] }[] }
    ).Statement;
    const write = statements.find((s) => s.Sid === "AlertingTableWrite");
    expect(write?.Action).toEqual(
      expect.arrayContaining(["dynamodb:PutItem", "dynamodb:UpdateItem"]),
    );
  });

  // Paging review MAJOR-A: list and end mark-offs early, key-scoped, Cedar-gated.
  it("gives list and end their own Lambdas, key-scoped grants and the policy store", async () => {
    const availability = await build();
    type Statement = { Sid?: string; Action: string[]; Condition?: unknown; Effect: string };
    const statementsOf = async (lambda: typeof availability.listLambda) =>
      (JSON.parse(await resolve(lambda.rolePolicy.policy)) as { Statement: Statement[] }).Statement;

    const list = await statementsOf(availability.listLambda);
    expect(list.find((s) => s.Sid === "AvailabilityListMarkoffs")).toMatchObject({
      Action: ["dynamodb:Query"],
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#MEMBER#*"] } },
    });

    const end = await statementsOf(availability.endLambda);
    const dynamoActions = end
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => s.Action)
      .filter((a) => a.startsWith("dynamodb:"));
    expect(dynamoActions.sort()).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    // (No DeleteItem allowed: the mark-off row is never deleted, so a replayed create 409s.)
    expect(end.find((s) => s.Sid === "AvailabilityDeleteSchedules")?.Action).toEqual([
      "scheduler:DeleteSchedule",
    ]);
    for (const lambda of [availability.listLambda, availability.endLambda]) {
      const env = await resolve(lambda.function.environment);
      expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
      expect(await resolve(lambda.rolePolicy.policy)).toContain(
        "verifiedpermissions:IsAuthorizedWithToken",
      );
    }
  });

  it("does not VPC-attach the availability-changed consumer", async () => {
    const availability = await build();
    const vpcConfig = await resolve(availability.availabilityChangedConsumer.function.vpcConfig);
    expect(vpcConfig).toBeUndefined();
  });
});

describe("Availability — mark-off expiry failure handling (B1-003)", () => {
  async function build() {
    const { Availability } = await import("../../components/personnel/availability");
    const logGroup = new ServiceLogGroup("test-expiry-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const alertingLogGroup = new ServiceLogGroup("test-expiry-alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const httpApi = new HttpApi("test-expiry-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Availability("test-expiry", {
      pageTopicArn: "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page",
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
      platformBus: new PlatformBus("test-expiry-platform-bus", { env: "dev" }),
      alertingTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/alerting"),
      alertingCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
      alertingTableName: pulumi.output("alerting-table"),
      alertingLogGroup,
    });
  }

  const PAGE_TOPIC = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";
  const ON_FAILURE_ARN =
    "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-personnel-availability-expiry-onfailure";
  const SCHEDULE_DLQ_ARN =
    "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-personnel-availability-scheduler-dlq";

  it("sends a failed async expiry invocation to an on-failure queue, with a paging depth alarm", async () => {
    const availability = await build();
    const config = await resolve(availability.expiryAsyncConfig.destinationConfig);
    expect(config).toEqual({ onFailure: { destination: ON_FAILURE_ARN } });
    expect(await resolve(availability.expiryAsyncConfig.functionName)).toBe(
      await resolve(availability.expiryLambda.function.name),
    );

    const alarm = availability.expiryOnFailureAlarm;
    expect(await resolve(alarm.metricName)).toBe("ApproximateNumberOfMessagesVisible");
    expect(await resolve(alarm.threshold)).toBe(0);
    expect(await resolve(alarm.alarmActions)).toEqual([PAGE_TOPIC]);
  });

  it("lets the expiry Lambda role write only its own on-failure queue", async () => {
    await build();
    await settleRecorded();
    const policy = recorded.find((r) => r.name === "test-expiry-expiry-onfailure-send");
    const statement = JSON.parse(
      String(await resolve(pulumi.output(policy?.inputs.policy as never))),
    ).Statement[0];
    expect(statement).toMatchObject({
      Action: ["sqs:SendMessage"],
      Resource: ON_FAILURE_ARN,
    });
  });

  it("dead-letters the runtime schedules: DLQ granted to the scheduler role, ARN handed to the create Lambda, depth paged", async () => {
    const availability = await build();
    const env = await resolve(availability.createLambda.function.environment);
    expect(env?.variables?.AVAILABILITY_SCHEDULE_DLQ_ARN).toBe(SCHEDULE_DLQ_ARN);

    await settleRecorded();
    const grant = recorded.find(
      (r) => r.name === "test-expiry-schedule-dead-letter-dlq-send-policy",
    );
    const statement = JSON.parse(
      String(await resolve(pulumi.output(grant?.inputs.policy as never))),
    ).Statement[0];
    expect(statement).toMatchObject({ Action: "sqs:SendMessage", Resource: SCHEDULE_DLQ_ARN });
    expect(grant?.inputs.role).toBe(await resolve(availability.schedulerRole.id));

    const depth = availability.scheduleDeadLetter.depthAlarm;
    expect(await resolve(depth.alarmActions)).toEqual([PAGE_TOPIC]);
  });
});
