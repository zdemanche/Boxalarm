import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { RETENTION_DAYS_BY_ENV } from "../../components/observability/service-log-group";

interface MockSchema {
  name: string;
  attributeDataType: string;
  mutable: boolean;
  required: boolean;
}

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.name}`;
      }
      if (args.type === "aws:cognito/userPool:UserPool") {
        state.arn = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${args.name}-id`;
      }
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

// registerOutputs() on the component wires in every child resource's Output, including
// ones a given test never directly asserts on. If a test returns before that whole
// graph settles, its resolution can fire after the next test's beforeEach has already
// swapped in a fresh mock monitor, producing an "unknown resource" unhandled rejection
// even though every assertion passed. Awaiting the full graph up front avoids that.
async function settle(identity: {
  userPool: { id: pulumi.Output<string> };
  userPoolDomain: { domain: pulumi.Output<string> };
  preTokenGenerationFunction: { arn: pulumi.Output<string> };
  functionRole: { arn: pulumi.Output<string> };
  functionLogGroup: { arn: pulumi.Output<string> };
  invokePermission: { id: pulumi.Output<string> };
}): Promise<void> {
  await Promise.all([
    resolve(identity.userPool.id),
    resolve(identity.userPoolDomain.domain),
    resolve(identity.preTokenGenerationFunction.arn),
    resolve(identity.functionRole.arn),
    resolve(identity.functionLogGroup.arn),
    resolve(identity.invokePermission.id),
  ]);
}

describe("BoxalarmUserPool", () => {
  it("declares deptId as a mutable, non-required custom attribute", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-schema", { env: "dev" });
    await settle(identity);

    const schemas = await resolve(identity.userPool.schemas as pulumi.Output<MockSchema[]>);
    const deptIdSchema = schemas.find((s) => s.name === "deptId");

    expect(deptIdSchema).toBeDefined();
    expect(deptIdSchema?.attributeDataType).toBe("String");
    expect(deptIdSchema?.mutable).toBe(true);
    expect(deptIdSchema?.required).toBe(false);
  });

  it("wires the pre-token-generation trigger as V2 so custom attributes reach the access token, not only the ID token", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-lambda-config", { env: "dev" });
    await settle(identity);

    const [lambdaConfig, fnArn] = await Promise.all([
      resolve(identity.userPool.lambdaConfig),
      resolve(identity.preTokenGenerationFunction.arn),
    ]);

    expect(lambdaConfig?.preTokenGenerationConfig?.lambdaVersion).toBe("V2_0");
    expect(lambdaConfig?.preTokenGenerationConfig?.lambdaArn).toBe(fnArn);
  });

  it("grants only this user pool permission to invoke the trigger function", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-permission", { env: "dev" });
    await settle(identity);

    const [principal, action, sourceArn, poolArn] = await Promise.all([
      resolve(identity.invokePermission.principal),
      resolve(identity.invokePermission.action),
      resolve(identity.invokePermission.sourceArn as pulumi.Output<string>),
      resolve(identity.userPool.arn),
    ]);

    expect(principal).toBe("cognito-idp.amazonaws.com");
    expect(action).toBe("lambda:InvokeFunction");
    expect(sourceArn).toBe(poolArn);
  });

  it("gives the trigger function its own retention-bounded log group rather than Lambda's default never-expire group", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-log-group", { env: "staging" });
    await settle(identity);

    const [name, retention, loggingConfig] = await Promise.all([
      resolve(identity.functionLogGroup.name),
      resolve(identity.functionLogGroup.retentionInDays),
      resolve(identity.preTokenGenerationFunction.loggingConfig),
    ]);

    expect(name).toBe("/aws/lambda/boxalarm-staging-identity-pre-token-generation");
    expect(retention).toBe(RETENTION_DAYS_BY_ENV.staging);
    expect(loggingConfig?.logGroup).toBe(name);
  });

  it("sets MFA configuration to OFF explicitly", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-mfa", { env: "dev" });
    await settle(identity);

    const mfa = await resolve(identity.userPool.mfaConfiguration);
    expect(mfa).toBe("OFF");
  });

  it("provisions a Cognito-hosted domain with prefix boxalarm-{env}", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-domain", { env: "qa" });
    await settle(identity);

    const domain = await resolve(identity.userPoolDomain.domain);
    expect(domain).toBe("boxalarm-qa");
    expect(identity.domainName).toBe("boxalarm-qa");
  });

  it("throws rather than provisioning a pool for an unknown env", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    expect(() => new BoxalarmUserPool("test-identity-bad-env", { env: "production" })).toThrow(
      /unknown env/,
    );
  });

  it("throws on absent env", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    expect(
      () => new BoxalarmUserPool("test-identity-no-env", { env: undefined as unknown as string }),
    ).toThrow(/env is required/);
  });
});
