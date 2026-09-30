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

describe("AuditRoute", () => {
  // Security-web MINOR 12: GET /platform/audit is Cedar ViewAuditTrail (CHIEF/ADMIN).
  it("gives the audit Lambda the policy store and IsAuthorized, beside its GSI3-only read", async () => {
    const { AuditRoute } = await import("../../components/platform/audit-route");
    const logGroup = new ServiceLogGroup("test-audit-lg", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-audit-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    const route = new AuditRoute("test-audit", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
    });

    const [policyJson, env] = await Promise.all([
      resolve(route.lambda.rolePolicy.policy),
      resolve(route.lambda.function.environment),
    ]);
    expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
    expect(policyJson).toContain("verifiedpermissions:IsAuthorizedWithToken");
    const statements = (JSON.parse(policyJson) as { Statement: Array<{ Action: string[] }> })
      .Statement;
    expect(statements.flatMap((s) => s.Action).filter((a) => a.startsWith("dynamodb:"))).toEqual([
      "dynamodb:Query",
    ]);
  });
});
