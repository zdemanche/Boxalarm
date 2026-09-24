import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

interface PolicyStatement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string[]>>;
}

let rolePolicyJson: string | undefined;

beforeEach(() => {
  rolePolicyJson = undefined;
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
      if (args.type === "aws:iam/rolePolicy:RolePolicy" && args.name.includes("fan-out-fn")) {
        rolePolicyJson = args.inputs.policy as string;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", description: "US East (N. Virginia)", id: "us-east-1" };
      }
      return args.inputs;
    },
  });
});

describe("FanOut KMS grant on the alerting table's CMK", () => {
  it("grants kms:Decrypt/Encrypt/GenerateDataKey*/DescribeKey on the CMK, scoped to DynamoDB", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { FanOut } = await import("../../components/alerting/fan-out");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const cmkArn = "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk";

    const fanOut = new FanOut("fan-out", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      alertingStreamArn:
        "arn:aws:dynamodb:us-east-1:123456789012:table/alerting/stream/2026-01-01T00:00:00.000",
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      alertingTableCmkArn: cmkArn,
      logGroup,
    });

    await new Promise((r) => fanOut.lambda.role.arn.apply(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(rolePolicyJson).toBeDefined();
    const statements = (JSON.parse(rolePolicyJson!) as { Statement: PolicyStatement[] }).Statement;
    const kmsStatement = statements.find((s) => s.Sid === "AlertingTableCmkAccess");
    expect(kmsStatement).toBeDefined();
    expect(kmsStatement!.Effect).toBe("Allow");
    expect(kmsStatement!.Action).toEqual(
      expect.arrayContaining([
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]),
    );
    expect(kmsStatement!.Resource).toBe(cmkArn);
    expect(kmsStatement!.Condition).toEqual({
      StringEquals: { "kms:ViaService": ["dynamodb.us-east-1.amazonaws.com"] },
    });
  });
});
