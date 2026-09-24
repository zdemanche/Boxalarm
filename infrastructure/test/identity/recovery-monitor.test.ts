import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:s3/bucket:Bucket") {
        state.arn = `arn:aws:s3:::${args.inputs.bucket ?? args.name}`;
        state.bucket = args.inputs.bucket ?? args.name;
      }
      if (args.type === "aws:cloudtrail/trail:Trail") {
        state.arn = `arn:aws:cloudtrail:us-east-1:123456789012:trail/${args.inputs.name}`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
        return {
          accountId: "123456789012",
          arn: "arn:aws:iam::123456789012:root",
          userId: "AIDATEST",
        };
      }
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", description: "US East (N. Virginia)", id: "us-east-1" };
      }
      return args.inputs;
    },
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("RecoveryMonitor", () => {
  async function build() {
    const { RecoveryMonitor } = await import("../../components/identity/recovery-monitor");
    const logGroup = new ServiceLogGroup("test-recovery-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    return new RecoveryMonitor("test-recovery", { env: "dev", logGroup });
  }

  it("watches Boxalarm/credential-recovery — the namespace the backend actually emits Recovery* metrics to", async () => {
    const monitor = await build();
    const [failedNs, classificationNs] = await Promise.all([
      resolve(monitor.recoveryFailedAlarm.namespace),
      resolve(monitor.classificationFailedAlarm.namespace),
    ]);
    // NOT "Boxalarm/platform-service" (metricsNamespaceFor("platform-service")) —
    // credential-recovery-monitor/handler.ts emits to the literal
    // "Boxalarm/credential-recovery".
    expect(failedNs).toBe("Boxalarm/credential-recovery");
    expect(classificationNs).toBe("Boxalarm/credential-recovery");
  });

  it("filters the CloudTrail rule to the two recovery event names", async () => {
    const monitor = await build();
    const eventPattern = await resolve(monitor.rule.eventPattern);
    const pattern = JSON.parse(eventPattern ?? "{}") as {
      detail: { eventName: string[] };
    };
    expect(pattern.detail.eventName).toEqual(["ForgotPassword", "ConfirmForgotPassword"]);
  });

  it("throws on absent or unknown env", async () => {
    const { RecoveryMonitor } = await import("../../components/identity/recovery-monitor");
    const logGroup = new ServiceLogGroup("test-recovery-log-group-bad", {
      env: "dev",
      serviceName: "platform-service",
    });
    expect(() => new RecoveryMonitor("test-recovery-bad", { env: "", logGroup })).toThrow(
      /env is required/,
    );
  });
});
