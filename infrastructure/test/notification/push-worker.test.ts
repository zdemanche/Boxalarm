import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { PushWorker } from "../../components/notification/push-worker";
import {
  ACCOUNT_ID,
  REGION,
  alarmByName,
  esmFor,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * The M7 closure wiring: the notification push topic finally has a subscriber. The chain is
 * topic -> raw SQS subscription (policy pinned to the topic ARN) -> queue + DLQ (alarmed) ->
 * worker Lambda, whose role may read the member rows and the three gateway secrets it uses —
 * and nothing of the alerting plane's.
 */

const PLATFORM_TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const ALERTING_TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-alerting-table`;
const PUSH_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-push`;
const CHIEF_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-chief-notifications`;
const QUEUE_NAME = "boxalarm-dev-notification-push-queue";
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}`;
const WORKER = "boxalarm-dev-notification-push-worker";
const secretArn = (name: string) =>
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${name}`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("notification-lg", {
    env: "dev",
    serviceName: "notification-service",
  });
  const secret = (key: string) =>
    new aws.secretsmanager.Secret(`push-${key}-secret`, {
      name: `boxalarm-dev-alerting-push-${key}-credentials`,
    });
  new PushWorker("notification-push-worker", {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    platformTableArn: pulumi.output(PLATFORM_TABLE),
    pushTopicArn: pulumi.output(PUSH_TOPIC),
    pushSecrets: {
      apns: secret("apns"),
      apnsSandbox: secret("apns-sandbox"),
      fcm: secret("fcm"),
      fcmSandbox: secret("fcm-sandbox"),
    },
    logGroup,
    opsAlarmTopicArn: CHIEF_TOPIC,
  });
  await settle();
}

describe("notification push worker wiring (M7)", { timeout: 30_000 }, () => {
  it("subscribes the queue to the push topic with raw delivery", async () => {
    await build();
    const subscription = resourcesOfType("aws:sns/topicSubscription:TopicSubscription").find(
      (s) => s.inputs.topic === PUSH_TOPIC,
    );
    expect(subscription).toBeDefined();
    expect(subscription?.inputs.protocol).toBe("sqs");
    expect(subscription?.inputs.endpoint).toBe(QUEUE_ARN);
    expect(subscription?.inputs.rawMessageDelivery).toBe(true);
  });

  it("pins the queue policy to the push topic ARN — nothing else may send", async () => {
    await build();
    const policy = resourcesOfType("aws:sqs/queuePolicy:QueuePolicy").find((p) =>
      String(p.inputs.policy).includes(QUEUE_ARN),
    );
    const document = JSON.parse(policy?.inputs.policy as string) as {
      Statement: {
        Principal: { Service: string };
        Condition: { ArnEquals: Record<string, string> };
      }[];
    };
    expect(document.Statement).toHaveLength(1);
    expect(document.Statement[0]?.Principal).toEqual({ Service: "sns.amazonaws.com" });
    expect(document.Statement[0]?.Condition).toEqual({
      ArnEquals: { "aws:SourceArn": PUSH_TOPIC },
    });
  });

  it("drains through its own queue with a DLQ, a concurrency cap and batch-item failures", async () => {
    await build();
    const esm = esmFor(WORKER);
    expect(esm.inputs.eventSourceArn).toBe(QUEUE_ARN);
    expect(esm.inputs.functionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect((esm.inputs.scalingConfig as { maximumConcurrency: number }).maximumConcurrency).toBe(
      5,
    );
    const queue = resourcesOfType("aws:sqs/queue:Queue").find(
      (q) => q.inputs.name === QUEUE_NAME,
    );
    const redrive = JSON.parse(queue?.inputs.redrivePolicy as string) as {
      deadLetterTargetArn: string;
      maxReceiveCount: number;
    };
    expect(redrive.deadLetterTargetArn).toBe(
      `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-push-dlq`,
    );
    expect(redrive.maxReceiveCount).toBe(5);
  });

  it("alarms the ops topic on DLQ depth, worker errors and first-attempt send failures", async () => {
    await build();
    for (const name of [
      "boxalarm-dev-notification-push-dlq-depth",
      "boxalarm-dev-notification-push-worker-errors",
      "boxalarm-dev-notification-push-send-failed",
    ]) {
      const alarm = alarmByName(name);
      expect(alarm.inputs.threshold, name).toBe(0);
      expect(alarm.inputs.alarmActions, name).toEqual([CHIEF_TOPIC]);
    }
  });

  it("gets the member table and exactly the three gateway secrets it uses", async () => {
    await build();
    expect(lambdaEnv(WORKER)).toMatchObject({
      PLATFORM_SERVICE_TABLE_NAME: "boxalarm-dev-platform-service",
      APNS_SECRET_ID: "boxalarm-dev-alerting-push-apns-credentials",
      APNS_SANDBOX_SECRET_ID: "boxalarm-dev-alerting-push-apns-sandbox-credentials",
      FCM_SECRET_ID: "boxalarm-dev-alerting-push-fcm-credentials",
    });
    // Never validate_only, so never the FCM sandbox secret.
    expect(lambdaEnv(WORKER).FCM_SANDBOX_SECRET_ID).toBeUndefined();
    const statements = statementsForRole(WORKER);
    expect(isGranted(statements, "dynamodb:GetItem", PLATFORM_TABLE)).toBe(true);
    // writePushDevices' dead-token correction: METADATA update + outbox Put, in one transaction.
    expect(isGranted(statements, "dynamodb:UpdateItem", PLATFORM_TABLE)).toBe(true);
    expect(isGranted(statements, "dynamodb:PutItem", PLATFORM_TABLE)).toBe(true);
    for (const key of ["apns", "apns-sandbox", "fcm"]) {
      expect(
        isGranted(
          statements,
          "secretsmanager:GetSecretValue",
          secretArn(`boxalarm-dev-alerting-push-${key}-credentials`),
        ),
        key,
      ).toBe(true);
    }
    expect(
      isGranted(
        statements,
        "secretsmanager:GetSecretValue",
        secretArn("boxalarm-dev-alerting-push-fcm-sandbox-credentials"),
      ),
    ).toBe(false);
  });

  it("holds NO permission on the alerting table, its CMK, or any alerting queue", async () => {
    await build();
    const statements = statementsForRole(WORKER);
    const allowed = statements.filter((statement) => statement.Effect === "Allow");
    for (const statement of allowed) {
      const resources = [statement.Resource].flat().map(String);
      const actions = [statement.Action].flat().map(String);
      // The shared gateway secrets are named alerting-push-*: the one sanctioned overlap.
      const nonSecretResources = resources.filter(
        (resource) => !resource.startsWith(`arn:aws:secretsmanager:`),
      );
      expect(
        nonSecretResources.some((resource) => resource.includes("alerting")),
        JSON.stringify(statement),
      ).toBe(false);
      if (actions.some((action) => action.startsWith("dynamodb:"))) {
        expect(resources.every((resource) => resource.startsWith(PLATFORM_TABLE))).toBe(true);
      }
      expect(actions.some((action) => action.startsWith("kms:"))).toBe(false);
    }
    expect(isGranted(statements, "dynamodb:GetItem", ALERTING_TABLE)).toBe(false);
    expect(isGranted(statements, "sqs:ReceiveMessage", (r) => r.includes("alerting"))).toBe(
      false,
    );
  });

  it("stays in the LOB failure domain: no reserved concurrency, standard queue", async () => {
    await build();
    const lambda = resourcesOfType("aws:lambda/function:Function").find(
      (l) => l.inputs.name === WORKER,
    );
    expect(lambda?.inputs.reservedConcurrentExecutions).toBeUndefined();
    const queue = resourcesOfType("aws:sqs/queue:Queue").find(
      (q) => q.inputs.name === QUEUE_NAME,
    );
    expect(queue?.inputs.fifoQueue).toBeFalsy();
  });
});
