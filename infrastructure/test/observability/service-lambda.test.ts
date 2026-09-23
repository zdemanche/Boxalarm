import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

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
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function settleLogGroup(logGroup: {
  logGroup: { urn: pulumi.Output<string> };
}): Promise<void> {
  await resolve(logGroup.logGroup.urn);
}

async function settleLambda(lambda: {
  function: { arn: pulumi.Output<string> };
  role: { arn: pulumi.Output<string> };
  rolePolicy: { id: pulumi.Output<string> };
}): Promise<void> {
  await Promise.all([
    resolve(lambda.function.arn),
    resolve(lambda.role.arn),
    resolve(lambda.rolePolicy.id),
  ]);
}

describe("ServiceLambda", () => {
  it("applies Active tracing, service log group, SERVICE_NAME/ENVIRONMENT, and observability IAM", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { ServiceLambda } = await import("../../components/observability/service-lambda");
    const { ACTIVE_TRACING_CONFIG } = await import("../../components/observability/xray-sampling");
    const { observabilityPolicyStatements } =
      await import("../../components/observability/observability-policy");

    const logGroup = new ServiceLogGroup("platform-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    await settleLogGroup(logGroup);
    const logGroupArn = await resolve(logGroup.logGroup.arn);

    const lambda = new ServiceLambda("platform-authorizer", {
      env: "dev",
      serviceName: "platform-service",
      functionName: "boxalarm-dev-platform-authorizer",
      handler: "index.handler",
      code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(
          "exports.handler = async () => ({ isAuthorized: false });",
        ),
      }),
      logGroup,
      environment: { COGNITO_USER_POOL_ID: "pool-id" },
    });

    await settleLambda(lambda);

    const [tracing, logging, envVars, roleName, policyDoc] = await Promise.all([
      resolve(lambda.function.tracingConfig),
      resolve(lambda.function.loggingConfig),
      resolve(lambda.function.environment),
      resolve(lambda.role.name),
      resolve(lambda.rolePolicy.policy),
    ]);

    expect(tracing).toEqual(ACTIVE_TRACING_CONFIG);
    expect(logging?.logGroup).toBe("/aws/lambda/boxalarm-dev-platform-service");
    expect(envVars?.variables?.SERVICE_NAME).toBe("platform-service");
    expect(envVars?.variables?.ENVIRONMENT).toBe("dev");
    expect(envVars?.variables?.COGNITO_USER_POOL_ID).toBe("pool-id");
    expect(roleName).toBe("boxalarm-dev-platform-authorizer");

    const expected = observabilityPolicyStatements(logGroupArn, "platform-service");
    const parsed = JSON.parse(policyDoc as string) as {
      Statement: Array<{ Sid: string; Action: string[]; Resource: string }>;
    };
    for (const statement of expected) {
      const found = parsed.Statement.find((s) => s.Sid === statement.Sid);
      expect(found).toBeDefined();
      expect(found?.Action).toEqual(statement.Action);
      expect(found?.Resource).toBe(statement.Resource);
    }
    expect(JSON.stringify(parsed)).not.toContain("dynamodb");
  });

  it("rejects VpcConfig for alerting-service Lambdas", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { ServiceLambda } = await import("../../components/observability/service-lambda");

    const logGroup = new ServiceLogGroup("alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    await settleLogGroup(logGroup);

    expect(
      () =>
        new ServiceLambda("alerting-bad-vpc", {
          env: "dev",
          serviceName: "alerting-service",
          functionName: "boxalarm-dev-alerting-bad",
          handler: "index.handler",
          code: new pulumi.asset.AssetArchive({
            "index.js": new pulumi.asset.StringAsset("exports.handler = async () => ({});"),
          }),
          logGroup,
          vpcConfig: {
            subnetIds: ["subnet-1"],
            securityGroupIds: ["sg-1"],
          },
        }),
    ).toThrow(/alerting-service.*VpcConfig/i);
  });

  it("does not set VpcConfig by default", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { ServiceLambda } = await import("../../components/observability/service-lambda");

    const logGroup = new ServiceLogGroup("incident-log-group", {
      env: "dev",
      serviceName: "incident-service",
    });
    await settleLogGroup(logGroup);

    const lambda = new ServiceLambda("incident-read", {
      env: "dev",
      serviceName: "incident-service",
      functionName: "boxalarm-dev-incident-read",
      handler: "index.handler",
      code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset("exports.handler = async () => ({});"),
      }),
      logGroup,
    });

    await settleLambda(lambda);
    const vpcConfig = await resolve(lambda.function.vpcConfig);
    expect(vpcConfig).toBeUndefined();
  });
});
