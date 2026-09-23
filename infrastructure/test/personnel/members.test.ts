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

describe("Members", () => {
  async function build() {
    const { Members } = await import("../../components/personnel/members");
    const logGroup = new ServiceLogGroup("test-members-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const httpApi = new HttpApi("test-members-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Members("test-members", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      logGroup,
      httpApi,
    });
  }

  it("grants no personnel role any permission on the alerting or incident tables (AC4)", async () => {
    const members = await build();
    const policies = await Promise.all([
      resolve(members.createLambda.rolePolicy.policy),
      resolve(members.listLambda.rolePolicy.policy),
      resolve(members.getLambda.rolePolicy.policy),
      resolve(members.updateStatusLambda.rolePolicy.policy),
    ]);
    for (const policyJson of policies) {
      expect(policyJson).not.toContain("table/alerting");
      expect(policyJson).not.toContain("table/incident");
    }
  });

  it("scopes updateStatus to the platform table plus the audit-key mutation deny", async () => {
    const members = await build();
    const policyJson = await resolve(members.updateStatusLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as { Statement: Array<{ Sid: string }> };
    expect(policy.Statement.some((s) => s.Sid === "DenyAuditMutations")).toBe(true);
  });

  it("grants Verified Permissions IsAuthorizedWithToken to every members Lambda", async () => {
    const members = await build();
    const policyJson = await resolve(members.createLambda.rolePolicy.policy);
    expect(policyJson).toContain("verifiedpermissions:IsAuthorizedWithToken");
  });
});
