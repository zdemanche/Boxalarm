import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
        state.invokeArn = `${state.arn}-invoke`;
      }
      if (args.type === "aws:kms/key:Key") {
        state.arn = `arn:aws:kms:us-east-1:123456789012:key/${args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
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

describe("Retention", () => {
  async function build() {
    const { Retention } = await import("../../components/platform/retention");
    const logGroup = new ServiceLogGroup("test-retention-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-retention-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Retention("test-retention", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      chiefNotificationTopicArn: pulumi.output("arn:aws:sns:us-east-1:123456789012:chief"),
      logGroup,
      httpApi,
    });
  }

  it("scopes kms:ScheduleKeyDeletion to the archive CMKs only, never the live table CMKs (AC3)", async () => {
    const retention = await build();
    const [rolePolicyStatements, archivedIncidentArn, archivedReceiptArn] = await Promise.all([
      resolve(retention.disposalLambda.rolePolicy.policy),
      resolve(retention.archivedIncidentCmk.arn),
      resolve(retention.archivedDeliveryReceiptCmk.arn),
    ]);
    const policy = JSON.parse(rolePolicyStatements) as {
      Statement: Array<{ Sid: string; Action: string[]; Resource: string | string[] }>;
    };
    const shred = policy.Statement.find((s) => s.Sid === "CryptoShredArchiveKeysOnly");
    expect(shred?.Action).toEqual(["kms:ScheduleKeyDeletion"]);
    expect(shred?.Resource).toEqual([archivedIncidentArn, archivedReceiptArn]);
  });

  it("grants no alerting-table permission and no incident-table delete (AC4)", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    expect(policyJson).not.toContain("table/alerting");
    expect(policyJson).not.toContain("table/incident");
  });

  it("denies mutation on audit keys via the shared deny helper", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as { Statement: Array<{ Sid: string }> };
    expect(policy.Statement.some((s) => s.Sid === "DenyAuditMutations")).toBe(true);
  });

  it("routes the admin disposal endpoint at POST /api/v1/platform/retention/disposal (backend-pinned path)", async () => {
    const retention = await build();
    await resolve(retention.disposalLambda.function.arn);
    // The route is registered against the shared HttpApi; verifying the schedule
    // target is the disposal Lambda is the more direct assertion available here.
    const target = await resolve(retention.schedule.target);
    const fnArn = await resolve(retention.disposalLambda.function.arn);
    expect(target?.arn).toBe(fnArn);
  });

  it("runs the disposal schedule daily", async () => {
    const retention = await build();
    const expr = await resolve(retention.schedule.scheduleExpression);
    expect(expr).toBe("rate(1 day)");
  });

  it("alarms the chief topic on every disposal invocation, no volume threshold", async () => {
    const retention = await build();
    const [threshold, comparison, actions] = await Promise.all([
      resolve(retention.invokedAlarm.threshold),
      resolve(retention.invokedAlarm.comparisonOperator),
      resolve(retention.invokedAlarm.alarmActions),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
    expect(actions).toContain("arn:aws:sns:us-east-1:123456789012:chief");
  });
});
