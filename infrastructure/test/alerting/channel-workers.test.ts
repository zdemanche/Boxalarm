import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { MessagingAlerting } from "../../components/alerting/messaging-alerting";
import { ChannelWorkers } from "../../components/alerting/channel-workers";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  esmFor,
  installMocks,
  lambdaByName,
  isGranted,
  lambdaEnv,
  settle,
  statementsForRole,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

async function buildWorkers() {
  const logGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const messaging = new MessagingAlerting("messaging-alerting", { env: "dev" });
  const workers = new ChannelWorkers("channel-workers", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    channelQueues: messaging.channelQueues,
    logGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return { messaging, workers };
}

const queueArn = (channel: string) =>
  `arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-${channel}-queue.fifo`;

describe("ChannelWorkers — each worker can drain only its own queue", { timeout: 30_000 }, () => {
  it.each(["push", "sms", "voice"])("%s worker", async (channel) => {
    await buildWorkers();
    const statements = statementsForRole(`boxalarm-dev-alerting-${channel}-worker`);
    for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) {
      expect(isGranted(statements, action, queueArn(channel))).toBe(true);
    }
    for (const other of ["push", "sms", "voice"].filter((c) => c !== channel)) {
      expect(isGranted(statements, "sqs:ReceiveMessage", queueArn(other))).toBe(false);
    }
  });
});

describe("ChannelWorkers — provider endpoints are config-driven (M5)", { timeout: 30_000 }, () => {
  it.each(["sms", "voice"])(
    "%s worker falls back to the RFC 2606 reserved .invalid TLD, and preview warns",
    async (channel) => {
      const warn = vi.spyOn(pulumi.log, "warn");
      const { workers } = await buildWorkers();
      const url = new URL(
        lambdaEnv(`boxalarm-dev-alerting-${channel}-worker`)[
          `${channel.toUpperCase()}_PROVIDER_ENDPOINT_URL`
        ]!,
      );
      expect(url.protocol).toBe("https:");
      expect(url.hostname.endsWith(".invalid")).toBe(true);
      expect(workers.vendorEndpointConfigured[channel as "sms" | "voice"]).toBe(false);
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes(`${channel}ProviderEndpointUrl`),
        ),
      ).toBe(true);
      warn.mockRestore();
    },
  );

  it("uses the configured endpoint for each vendor channel, and does not warn", async () => {
    installMocks({
      "boxalarm-infra:smsProviderEndpointUrl": "https://api.sms-vendor.test/v1/messages",
      "boxalarm-infra:voiceProviderEndpointUrl": "https://api.voice-vendor.test/v1/calls",
    });
    const warn = vi.spyOn(pulumi.log, "warn");
    const { workers } = await buildWorkers();
    expect(lambdaEnv("boxalarm-dev-alerting-sms-worker").SMS_PROVIDER_ENDPOINT_URL).toBe(
      "https://api.sms-vendor.test/v1/messages",
    );
    expect(lambdaEnv("boxalarm-dev-alerting-voice-worker").VOICE_PROVIDER_ENDPOINT_URL).toBe(
      "https://api.voice-vendor.test/v1/calls",
    );
    expect(workers.vendorEndpointConfigured).toEqual({ sms: true, voice: true });
    expect(warn.mock.calls.some(([m]) => String(m).includes("ProviderEndpointUrl"))).toBe(false);
    warn.mockRestore();
  });
});

const secretArn = (name: string) => `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}`;
const PUSH_SECRET_NAMES = [
  "boxalarm-dev-alerting-push-apns-credentials",
  "boxalarm-dev-alerting-push-apns-sandbox-credentials",
  "boxalarm-dev-alerting-push-fcm-credentials",
  "boxalarm-dev-alerting-push-fcm-sandbox-credentials",
];
const VENDOR_SECRET_NAMES = ["sms", "voice"].flatMap((channel) => [
  `boxalarm-dev-alerting-${channel}-provider-credentials`,
  `boxalarm-dev-alerting-${channel}-provider-sandbox-credentials`,
]);

describe("ChannelWorkers — push goes to APNs/FCM directly", { timeout: 30_000 }, () => {
  it("the push worker gets the APNs/FCM secret IDs and sandbox twins, and no vendor endpoint", async () => {
    await buildWorkers();
    const env = lambdaEnv("boxalarm-dev-alerting-push-worker");
    expect(env.APNS_SECRET_ID).toBe("boxalarm-dev-alerting-push-apns-credentials");
    expect(env.APNS_SANDBOX_SECRET_ID).toBe("boxalarm-dev-alerting-push-apns-sandbox-credentials");
    expect(env.FCM_SECRET_ID).toBe("boxalarm-dev-alerting-push-fcm-credentials");
    expect(env.FCM_SANDBOX_SECRET_ID).toBe("boxalarm-dev-alerting-push-fcm-sandbox-credentials");
    // The placeholder push endpoint (and the generic vendor path) is gone.
    expect(Object.keys(env).filter((key) => key.startsWith("PUSH_PROVIDER_"))).toEqual([]);
    expect(Object.values(env).some((value) => String(value).includes(".invalid"))).toBe(false);
  });

  it("the push worker can read exactly its four gateway secrets and no other channel's", async () => {
    await buildWorkers();
    const statements = statementsForRole("boxalarm-dev-alerting-push-worker");
    for (const name of PUSH_SECRET_NAMES) {
      expect(isGranted(statements, "secretsmanager:GetSecretValue", secretArn(name))).toBe(true);
    }
    for (const name of VENDOR_SECRET_NAMES) {
      expect(isGranted(statements, "secretsmanager:GetSecretValue", secretArn(name))).toBe(false);
    }
    const secretStatements = statements.filter((statement) =>
      [statement.Action].flat().some((action) => String(action).startsWith("secretsmanager:")),
    );
    expect(secretStatements.flatMap((statement) => [statement.Action].flat())).toEqual([
      "secretsmanager:GetSecretValue",
    ]);
    expect(secretStatements.flatMap((statement) => [statement.Resource].flat()).sort()).toEqual(
      PUSH_SECRET_NAMES.map(secretArn).sort(),
    );
  });

  it.each(["sms", "voice"])(
    "the %s worker cannot read the push gateway secrets",
    async (channel) => {
      await buildWorkers();
      const statements = statementsForRole(`boxalarm-dev-alerting-${channel}-worker`);
      for (const name of PUSH_SECRET_NAMES) {
        expect(isGranted(statements, "secretsmanager:GetSecretValue", secretArn(name))).toBe(false);
      }
    },
  );
});

describe("ChannelWorkers — sandbox credentials reach each worker", { timeout: 30_000 }, () => {
  it.each(["sms", "voice"])(
    "%s worker gets its own prod and sandbox secret IDs, and can read both",
    async (channel) => {
      await buildWorkers();
      const upper = channel.toUpperCase();
      const env = lambdaEnv(`boxalarm-dev-alerting-${channel}-worker`);
      expect(env[`${upper}_PROVIDER_SECRET_ID`]).toBe(
        `boxalarm-dev-alerting-${channel}-provider-credentials`,
      );
      expect(env[`${upper}_PROVIDER_SANDBOX_SECRET_ID`]).toBe(
        `boxalarm-dev-alerting-${channel}-provider-sandbox-credentials`,
      );
      const statements = statementsForRole(`boxalarm-dev-alerting-${channel}-worker`);
      const sandboxArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:boxalarm-dev-alerting-${channel}-provider-sandbox-credentials`;
      expect(isGranted(statements, "secretsmanager:GetSecretValue", sandboxArn)).toBe(true);
    },
  );
});

describe(
  "ChannelWorkers — SQS ESM concurrency matches reserved concurrency",
  { timeout: 30_000 },
  () => {
    it.each(["push", "sms", "voice"])("%s worker", async (channel) => {
      await buildWorkers();
      const functionName = `boxalarm-dev-alerting-${channel}-worker`;
      const reserved = lambdaByName(functionName).inputs.reservedConcurrentExecutions as number;
      expect(reserved).toBe(5);
      expect(esmFor(functionName).inputs.scalingConfig).toEqual({ maximumConcurrency: reserved });
    });
  },
);
