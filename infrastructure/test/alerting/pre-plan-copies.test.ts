import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  PRE_PLAN_COPY_RESERVED_CONCURRENCY,
  PRE_PLAN_COPY_TIMEOUT_SECONDS,
  PrePlanCopies,
} from "../../components/alerting/pre-plan-copies";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  alarmByName,
  esmFor,
  installMocks,
  isGranted,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";
const BUS_NAME = "boxalarm-dev-platform-bus";

const CONSUMERS = [
  {
    key: "preplan-copy",
    detailType: "inspections.preplan.updated",
    functionName: "boxalarm-dev-alerting-preplan-copy-consumer",
    leadingKeys: ["DEPT#*#PREPLAN", "DEPT#*#DEDUP#preplan-copy-consumer#*"],
  },
  {
    key: "hydrant-copy",
    detailType: "inspections.hydrant.updated",
    functionName: "boxalarm-dev-alerting-hydrant-copy-consumer",
    leadingKeys: ["DEPT#*#HYDRANT", "DEPT#*#DEDUP#hydrant-copy-consumer#*"],
  },
] as const;

beforeEach(() => {
  installMocks();
});

async function build(): Promise<PrePlanCopies> {
  const logGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const copies = new PrePlanCopies("pre-plan-copies", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    busName: BUS_NAME,
    pageTopicArn: PAGE_TOPIC_ARN,
    logGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return copies;
}

function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe.each(CONSUMERS)("PrePlanCopies — $key consumer", (consumer) => {
  it("routes only inspections-service's event of this type from the platform bus to its queue", async () => {
    await build();
    const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
      (r) => r.inputs.name === `boxalarm-dev-alerting-${consumer.key}`,
    );
    expect(rule?.inputs.eventBusName).toBe(BUS_NAME);
    expect(JSON.parse(rule?.inputs.eventPattern as string)).toEqual({
      source: ["inspections-service"],
      "detail-type": [consumer.detailType],
    });
    const target = resourcesOfType("aws:cloudwatch/eventTarget:EventTarget").find(
      (t) => t.inputs.rule === `boxalarm-dev-alerting-${consumer.key}`,
    );
    expect(target?.inputs.arn).toBe(
      `arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-${consumer.key}-queue`,
    );
    // No input transformer: the handler parses the whole EventBridge event (`detail`).
    expect(target?.inputs.inputTransformer).toBeUndefined();
    expect(target?.inputs.inputPath).toBeUndefined();
  });

  it("lets only its own rule send to the queue", async () => {
    await build();
    const policy = resourcesOfType("aws:sqs/queuePolicy:QueuePolicy").find((p) =>
      String(p.inputs.queueUrl).endsWith(`boxalarm-dev-alerting-${consumer.key}-queue`),
    );
    const statement = (
      JSON.parse(policy?.inputs.policy as string) as {
        Statement: Array<{ Principal: unknown; Condition: unknown }>;
      }
    ).Statement[0];
    expect(statement?.Principal).toEqual({ Service: "events.amazonaws.com" });
    expect(statement?.Condition).toEqual({
      ArnEquals: {
        "aws:SourceArn": `arn:aws:events:us-east-1:123456789012:rule/boxalarm-dev-alerting-${consumer.key}`,
      },
    });
  });

  it("dead-letters after 5 receives, with visibility covering the function timeout", async () => {
    await build();
    const queue = resourcesOfType("aws:sqs/queue:Queue").find(
      (q) => q.inputs.name === `boxalarm-dev-alerting-${consumer.key}-queue`,
    );
    expect(JSON.parse(queue?.inputs.redrivePolicy as string)).toEqual({
      deadLetterTargetArn: `arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-${consumer.key}-dlq`,
      maxReceiveCount: 5,
    });
    expect(queue?.inputs.visibilityTimeoutSeconds as number).toBeGreaterThanOrEqual(
      PRE_PLAN_COPY_TIMEOUT_SECONDS * 6,
    );
    expect(lambdaByName(consumer.functionName).inputs.timeout).toBe(PRE_PLAN_COPY_TIMEOUT_SECONDS);
  });

  it("drains the queue into the consumer Lambda, capped at its reserved concurrency", async () => {
    await build();
    const esm = esmFor(consumer.functionName);
    expect(esm.inputs.eventSourceArn).toBe(
      `arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-${consumer.key}-queue`,
    );
    expect(esm.inputs.scalingConfig).toEqual({
      maximumConcurrency: PRE_PLAN_COPY_RESERVED_CONCURRENCY,
    });
    expect(lambdaByName(consumer.functionName).inputs.reservedConcurrentExecutions).toBe(
      PRE_PLAN_COPY_RESERVED_CONCURRENCY,
    );
    const statements = statementsForRole(consumer.functionName);
    for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) {
      expect(isGranted(statements, action, (r) => r.endsWith(`${consumer.key}-queue`))).toBe(true);
    }
  });

  it("writes only its own partitions of the alerting table — no read, no other table", async () => {
    await build();
    const statements = statementsForRole(consumer.functionName);
    const dynamo = statements.filter((s) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).some((a) => a.startsWith("dynamodb:")),
    );
    expect(dynamo).toHaveLength(1);
    expect(dynamo[0]).toMatchObject({
      Effect: "Allow",
      Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
      Resource: TABLE_ARN,
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...consumer.leadingKeys] },
      },
    });
    expect(isGranted(statements, "kms:Decrypt", CMK_ARN)).toBe(true);
  });

  it("runs under the alerting permissions boundary, outside the VPC, with only the alerting table name", async () => {
    await build();
    const role = resourcesOfType("aws:iam/role:Role").find(
      (r) => r.inputs.name === consumer.functionName,
    );
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
    expect(lambdaByName(consumer.functionName).inputs.vpcConfig).toBeUndefined();
    expect(lambdaEnv(consumer.functionName)).toEqual(
      expect.objectContaining({ ALERTING_TABLE_NAME: "boxalarm-dev-alerting-table" }),
    );
    expect(
      Object.keys(lambdaEnv(consumer.functionName)).some((k) => /PLATFORM|INCIDENT/.test(k)),
    ).toBe(false);
  });

  it("pages through the alerting-page topic when its DLQ is not empty", async () => {
    await build();
    const alarm = alarmByName(`boxalarm-dev-alerting-${consumer.key}-dlq-not-empty`);
    expect(alarm.inputs).toMatchObject({
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: `boxalarm-dev-alerting-${consumer.key}-dlq` },
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      alarmActions: [PAGE_TOPIC_ARN],
    });
  });
});

describe("PrePlanCopies — component outputs", () => {
  it("exposes both consumers' queues for wiring and alarms", async () => {
    const copies = await build();
    const [prePlanQueue, hydrantQueue] = await Promise.all([
      resolve(copies.prePlan.queue.name),
      resolve(copies.hydrant.queue.name),
    ]);
    expect(prePlanQueue).toBe("boxalarm-dev-alerting-preplan-copy-queue");
    expect(hydrantQueue).toBe("boxalarm-dev-alerting-hydrant-copy-queue");
  });
});
