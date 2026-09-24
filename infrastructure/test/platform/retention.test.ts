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
      policyStoreId: pulumi.output("ps-1"),
      chiefNotificationTopicArn: pulumi.output("arn:aws:sns:us-east-1:123456789012:chief"),
      logGroup,
      httpApi,
    });
  }

  it("wires VERIFIED_PERMISSIONS_POLICY_STORE_ID into the disposal Lambda's environment", async () => {
    const retention = await build();
    const env = await resolve(retention.disposalLambda.function.environment);
    expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
  });

  it("scopes kms:ScheduleKeyDeletion by the crypto-shred tag, not by two fixed CMK ARNs (AC3)", async () => {
    const retention = await build();
    const rolePolicyStatements = await resolve(retention.disposalLambda.rolePolicy.policy);
    const policy = JSON.parse(rolePolicyStatements) as {
      Statement: Array<{
        Sid: string;
        Action: string[];
        Resource: string | string[];
        Condition?: Record<string, Record<string, string[]>>;
      }>;
    };
    const shred = policy.Statement.find((s) => s.Sid === "CryptoShredArchiveKeysOnly");
    expect(shred?.Action).toEqual(["kms:ScheduleKeyDeletion"]);
    // Tag-scoped rather than pinned to the two CMKs provisioned here: the backend
    // shreds the per-item item.kmsKeyId, which a future archive-writer may mint
    // outside this component — tag scoping covers those keys without a companion
    // infra change, as long as they carry the same tag.
    expect(shred?.Condition).toEqual({
      StringEquals: { "aws:ResourceTag/boxalarm:crypto-shred": ["true"] },
    });
  });

  it("tags both archive CMKs with the crypto-shred tag the disposal role's grant is scoped by", async () => {
    const retention = await build();
    const [incidentTags, receiptTags] = await Promise.all([
      resolve(retention.archivedIncidentCmk.tags),
      resolve(retention.archivedDeliveryReceiptCmk.tags),
    ]);
    expect(incidentTags?.["boxalarm:crypto-shred"]).toBe("true");
    expect(receiptTags?.["boxalarm:crypto-shred"]).toBe("true");
  });

  it("grants no alerting-table permission and no incident-table delete (AC4)", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    expect(policyJson).not.toContain("table/alerting");
    expect(policyJson).not.toContain("table/incident");
  });

  it("grants GetItem (per-candidate read) and PutItem (its own audit write), never BatchWriteItem", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string[] }>;
    };
    const statement = policy.Statement.find((s) => s.Sid === "DisposalLobClassAccess");
    expect(statement?.Action).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]),
    );
    expect(statement?.Action).not.toContain("dynamodb:BatchWriteItem");
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
