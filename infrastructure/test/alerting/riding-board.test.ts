import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

interface PolicyStatement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
}

let rolePolicyByName: Record<string, string>;

beforeEach(() => {
  rolePolicyByName = {};
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        const fnName = (args.inputs.name as string) ?? args.name;
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${fnName}`;
        state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${state.arn}/invocations`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
        state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}`;
      }
      if (args.type === "aws:iam/rolePolicy:RolePolicy") {
        rolePolicyByName[args.name] = args.inputs.policy as string;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
  pulumi.runtime.setAllConfig({
    "boxalarm-infra:env": "dev",
    "boxalarm-infra:webOrigin": "https://localhost:5173",
  });
});

function statementsFor(roleResourceNameSubstring: string): PolicyStatement[] {
  const [, policyJson] =
    Object.entries(rolePolicyByName).find(([name]) => name.includes(roleResourceNameSubstring)) ??
    [];
  if (!policyJson) {
    throw new Error(
      `no RolePolicy captured matching "${roleResourceNameSubstring}"; captured: ${Object.keys(rolePolicyByName).join(", ")}`,
    );
  }
  return (JSON.parse(policyJson) as { Statement: PolicyStatement[] }).Statement;
}

function hasAction(
  statements: PolicyStatement[],
  action: string,
  predicate: (resource: string) => boolean,
): boolean {
  return statements.some((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    return s.Effect === "Allow" && actions.includes(action) && resources.some(predicate);
  });
}

describe("RidingBoard IAM matches the merged backend's actual DynamoDB calls", () => {
  it("GET grants dynamodb:Query on the table's GSI3 index (listApparatusForBoard)", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");
    const { RidingBoard } = await import("../../components/alerting/riding-board");

    const platformLogGroup = new ServiceLogGroup("platform-lg", {
      env: "dev",
      serviceName: "platform-service",
    });
    const apparatusLogGroup = new ServiceLogGroup("apparatus-lg", {
      env: "dev",
      serviceName: "apparatus-service",
    });
    const httpApi = new HttpApi("http-api", {
      env: "dev",
      userPoolId: "pool-1",
      allowedClientIds: ["client-1"],
      platformLogGroup,
    });
    const tableArn = "arn:aws:dynamodb:us-east-1:123456789012:table/platform";

    new RidingBoard("riding-board", {
      env: "dev",
      httpApi,
      platformTableArn: tableArn,
      platformTableName: "boxalarm-dev-platform-table",
      logGroup: apparatusLogGroup,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const statements = statementsFor("riding-board-get-fn-role-policy");
    expect(hasAction(statements, "dynamodb:Query", (r) => r === `${tableArn}/index/GSI3`)).toBe(
      true,
    );
    expect(hasAction(statements, "dynamodb:GetItem", (r) => r === tableArn)).toBe(true);
  });

  it("assign grants dynamodb:Query on GSI3 (findApparatusItem) and dynamodb:TransactWriteItems on the table (not UpdateItem, which the backend never calls)", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");
    const { RidingBoard } = await import("../../components/alerting/riding-board");

    const platformLogGroup = new ServiceLogGroup("platform-lg", {
      env: "dev",
      serviceName: "platform-service",
    });
    const apparatusLogGroup = new ServiceLogGroup("apparatus-lg", {
      env: "dev",
      serviceName: "apparatus-service",
    });
    const httpApi = new HttpApi("http-api", {
      env: "dev",
      userPoolId: "pool-1",
      allowedClientIds: ["client-1"],
      platformLogGroup,
    });
    const tableArn = "arn:aws:dynamodb:us-east-1:123456789012:table/platform";

    new RidingBoard("riding-board", {
      env: "dev",
      httpApi,
      platformTableArn: tableArn,
      platformTableName: "boxalarm-dev-platform-table",
      logGroup: apparatusLogGroup,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const statements = statementsFor("riding-board-assign-fn-role-policy");
    expect(hasAction(statements, "dynamodb:Query", (r) => r === `${tableArn}/index/GSI3`)).toBe(
      true,
    );
    expect(hasAction(statements, "dynamodb:GetItem", (r) => r === tableArn)).toBe(true);
    expect(hasAction(statements, "dynamodb:TransactWriteItems", (r) => r === tableArn)).toBe(true);
  });
});
