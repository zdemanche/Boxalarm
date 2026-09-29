import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-platform-service";
const CREDENTIALS_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:boxalarm-dev-neris-client-credentials";

const routeKeys: string[] = [];

beforeEach(() => {
  routeKeys.length = 0;
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:apigatewayv2/route:Route") {
        routeKeys.push(args.inputs.routeKey as string);
      }
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

interface PolicyDoc {
  Statement: Array<{ Sid: string; Action: string[] | string; Resource: string | string[] }>;
}

describe("NerisEntity", () => {
  async function build() {
    const { NerisEntity } = await import("../../components/platform/neris-entity");
    const logGroup = new ServiceLogGroup("test-neris-entity-lg", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-neris-entity-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new NerisEntity("test-neris-entity", {
      env: "dev",
      platformTableName: pulumi.output("boxalarm-dev-platform-service"),
      platformTableArn: pulumi.output(TABLE_ARN),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      nerisCredentialsSecretArn: pulumi.output(CREDENTIALS_ARN),
      logGroup,
      httpApi,
    });
  }

  it("routes GET and PUT /platform/neris/entity to their own Lambdas", async () => {
    const entity = await build();
    await resolve(entity.putLambda.function.arn);
    await new Promise((r) => setImmediate(r));
    expect(routeKeys).toEqual(
      expect.arrayContaining([
        "GET /api/v1/platform/neris/entity",
        "PUT /api/v1/platform/neris/entity",
      ]),
    );
  });

  it("gives only the sync (PUT) NERIS credentials; the read is one GetItem", async () => {
    const entity = await build();
    const get = JSON.parse(await resolve(entity.getLambda.rolePolicy.policy)) as PolicyDoc;
    const put = JSON.parse(await resolve(entity.putLambda.rolePolicy.policy)) as PolicyDoc;
    expect(get.Statement.find((s) => s.Sid === "NerisEntityRead")?.Action).toEqual([
      "dynamodb:GetItem",
    ]);
    expect(get.Statement.some((s) => s.Sid.startsWith("NerisGet"))).toBe(false);
    expect(put.Statement.find((s) => s.Sid === "NerisEntitySyncAccess")?.Action).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]);
    expect(put.Statement.some((s) => s.Sid.startsWith("NerisGet"))).toBe(true);
    const env = await resolve(entity.putLambda.function.environment);
    expect(env?.variables).toMatchObject({
      PLATFORM_TABLE_NAME: "boxalarm-dev-platform-service",
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: "ps-1",
      NERIS_CREDENTIALS_SECRET_ID: CREDENTIALS_ARN,
      BOXALARM_ENV: "dev",
    });
  });
});
