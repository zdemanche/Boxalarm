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
      if (args.type === "aws:s3/bucket:Bucket") {
        state.arn = `arn:aws:s3:::${args.inputs.bucket ?? args.name}`;
        state.bucket = args.inputs.bucket ?? args.name;
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
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("Export", () => {
  async function build() {
    const { Export } = await import("../../components/platform/export");
    const logGroup = new ServiceLogGroup("test-export-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-export-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Export("test-export", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      incidentTableName: pulumi.output("incident-table"),
      incidentTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/incident"),
      alertingTableName: pulumi.output("alerting-table"),
      alertingTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/alerting"),
      alertingCmkArn: pulumi.output("arn:aws:kms:us-east-1:123456789012:key/alerting-cmk"),
      incidentCmkArn: pulumi.output("arn:aws:kms:us-east-1:123456789012:key/incident-cmk"),
      chiefNotificationTopicArn: pulumi.output("arn:aws:sns:us-east-1:123456789012:chief"),
      logGroup,
      httpApi,
    });
  }

  it("wires the real alerting/incident table names into the worker's environment", async () => {
    const exp = await build();
    const env = await resolve(exp.workerLambda.environment);
    expect(env?.variables?.ALERTING_TABLE_NAME).toBe("alerting-table");
    expect(env?.variables?.INCIDENT_TABLE_NAME).toBe("incident-table");
  });

  it("grants the worker role zero DynamoDB write actions, only read-only + decrypt + bucket write (AC1)", async () => {
    const exp = await build();
    const policyJson = await resolve(exp.workerRolePolicy.policy);
    const policy = JSON.parse(policyJson) as { Statement: Array<{ Action: string[] }> };
    const allActions = policy.Statement.flatMap((s) => s.Action);
    const writeActions = allActions.filter((a) =>
      /^dynamodb:(Put|Update|Delete|BatchWrite|TransactWrite)/.test(a),
    );
    expect(writeActions).toEqual([]);
    expect(allActions).toEqual(
      expect.arrayContaining([
        "dynamodb:Scan",
        "dynamodb:Query",
        "dynamodb:GetItem",
        "kms:Decrypt",
      ]),
    );
  });

  it("is the only principal outside alerting-service with alerting-table access (AC2) — worker role references the alerting table ARN", async () => {
    const exp = await build();
    const policyJson = await resolve(exp.workerRolePolicy.policy);
    expect(policyJson).toContain("arn:aws:dynamodb:us-east-1:123456789012:table/alerting");
  });

  it("gives the export worker Lambda the dedicated read-only role, not a fresh ServiceLambda role", async () => {
    const exp = await build();
    const [workerRoleArn, functionRoleArn] = await Promise.all([
      resolve(exp.workerRole.arn),
      resolve(exp.workerLambda.role),
    ]);
    expect(functionRoleArn).toBe(workerRoleArn);
  });

  it("names the dedicated worker role boxalarm-{env}-platform-export-readonly", async () => {
    const exp = await build();
    const name = await resolve(exp.workerRole.name);
    expect(name).toBe("boxalarm-dev-platform-export-readonly");
  });

  it("names the staging bucket per env, not a global literal (prevents cross-env bucket adoption)", async () => {
    const exp = await build();
    const bucketName = await resolve(exp.stagingBucket.bucket);
    expect(bucketName).toBe("boxalarm-dev-exports-staging");
  });

  it("expires the staging bucket's objects after 7 days and aborts stale multipart uploads", async () => {
    const exp = await build();
    const rules = (await resolve(exp.stagingBucketLifecycle.rules)) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.status).toBe("Enabled");
    expect(rules[0]?.expiration?.days).toBe(7);
    expect(rules[0]?.abortIncompleteMultipartUpload?.daysAfterInitiation).toBe(7);
  });

  it("gates the ExportInvoked alarm on Sum >= 1 with no volume threshold, notifying the chief topic (AC2)", async () => {
    const exp = await build();
    const [threshold, comparison, actions] = await Promise.all([
      resolve(exp.invokedAlarm.threshold),
      resolve(exp.invokedAlarm.comparisonOperator),
      resolve(exp.invokedAlarm.alarmActions),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
    expect(actions).toContain("arn:aws:sns:us-east-1:123456789012:chief");
  });

  it("grants the handler GetItem/PutItem/UpdateItem on the platform table, never the non-functional TransactWriteItems", async () => {
    const exp = await build();
    const policyJson = await resolve(exp.handlerLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string[] }>;
    };
    const statement = policy.Statement.find((s) => s.Sid === "ExportTableAccess");
    expect(statement?.Action).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
    );
    expect(policyJson).not.toContain("TransactWriteItems");
  });

  it("throws on absent or unknown env", async () => {
    const { Export } = await import("../../components/platform/export");
    const logGroup = new ServiceLogGroup("test-export-log-group-bad", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-export-http-api-bad", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    expect(
      () =>
        new Export("test-export-bad", {
          env: "",
          platformTableName: pulumi.output("t"),
          platformTableArn: pulumi.output("arn"),
          incidentTableName: pulumi.output("incident-table"),
          incidentTableArn: pulumi.output("arn"),
          alertingTableName: pulumi.output("alerting-table"),
          alertingTableArn: pulumi.output("arn"),
          alertingCmkArn: pulumi.output("arn"),
          incidentCmkArn: pulumi.output("arn"),
          chiefNotificationTopicArn: pulumi.output("arn"),
          logGroup,
          httpApi,
        }),
    ).toThrow(/env is required/);
  });
});
