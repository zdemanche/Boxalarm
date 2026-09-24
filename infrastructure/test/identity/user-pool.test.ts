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
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
        return {
          accountId: "123456789012",
          arn: "arn:aws:iam::123456789012:root",
          userId: "AIDATEST",
        };
      }
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", description: "US East (N. Virginia)", id: "us-east-1" };
      }
      return args.inputs;
    },
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
  // The pool's dependsOn: [invokePermission] adds an extra async hop before
  // registerOutputs fires; give the mock monitor a turn to finish before the next
  // test's beforeEach swaps it out (same pattern used in the other component tests).
  await new Promise((r) => setImmediate(r));
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

  it("grants a region/account-scoped invoke permission, created independently of the pool so it exists before any sign-in can occur", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-permission", { env: "dev" });
    await settle(identity);

    const [principal, action, sourceArn] = await Promise.all([
      resolve(identity.invokePermission.principal),
      resolve(identity.invokePermission.action),
      resolve(identity.invokePermission.sourceArn as pulumi.Output<string>),
    ]);

    expect(principal).toBe("cognito-idp.amazonaws.com");
    expect(action).toBe("lambda:InvokeFunction");
    // Wildcard-scoped, not this.userPool.arn — not depending on the pool's own output
    // is what lets Pulumi create the permission before the pool exists.
    expect(sourceArn).toBe("arn:aws:cognito-idp:us-east-1:123456789012:userpool/*");
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

  it("logs JSON and enables Active tracing on the pre-token trigger — the highest-availability-criticality function here (if it fails, every sign-in fails)", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const { ACTIVE_TRACING_CONFIG } = await import("../../components/observability/xray-sampling");
    const identity = new BoxalarmUserPool("test-identity-observability", { env: "dev" });
    await settle(identity);

    const [loggingConfig, tracingConfig] = await Promise.all([
      resolve(identity.preTokenGenerationFunction.loggingConfig),
      resolve(identity.preTokenGenerationFunction.tracingConfig),
    ]);

    expect(loggingConfig?.logFormat).toBe("JSON");
    expect(tracingConfig).toEqual(ACTIVE_TRACING_CONFIG);
  });

  it("sets MFA configuration to OFF explicitly", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-mfa", { env: "dev" });
    await settle(identity);

    const mfa = await resolve(identity.userPool.mfaConfiguration);
    expect(mfa).toBe("OFF");
  });

  it("enables deletion protection — unlike DynamoDB, Cognito has no PITR/restore path", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-deletion-protection", { env: "dev" });
    await settle(identity);

    const deletionProtection = await resolve(identity.userPool.deletionProtection);
    expect(deletionProtection).toBe("ACTIVE");
  });

  it("recovers via verified email first then verified phone, with no human step (E8-S2-INFRA AC1)", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-recovery", { env: "dev" });
    await settle(identity);

    const setting = await resolve(identity.userPool.accountRecoverySetting);
    expect(setting?.recoveryMechanisms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "verifiedEmail", priority: 1 }),
        expect.objectContaining({ name: "verifiedPhoneNumber", priority: 2 }),
      ]),
    );
  });

  it("scopes the Cognito SMS role's trust to this pool's external ID AND this account/a Cognito pool ARN (confused-deputy hardening)", async () => {
    const { BoxalarmUserPool } = await import("../../components/identity/user-pool");
    const identity = new BoxalarmUserPool("test-identity-sms", { env: "dev" });
    await settle(identity);

    const [policy, smsConfig] = await Promise.all([
      resolve(identity.smsRole.assumeRolePolicy),
      resolve(identity.userPool.smsConfiguration),
    ]);
    const parsed = JSON.parse(policy) as {
      Statement: Array<{
        Condition?: {
          StringEquals?: Record<string, string>;
          ArnLike?: Record<string, string>;
        };
      }>;
    };
    // The external ID alone is guessable (it follows the same
    // boxalarm-${env}-identity-sms pattern as the role name), so it isn't sufficient
    // on its own — aws:SourceAccount and aws:SourceArn must also be present, pinning
    // the assumption to THIS account and a Cognito user pool in it.
    expect(parsed.Statement[0]?.Condition?.StringEquals).toMatchObject({
      "sts:ExternalId": "boxalarm-dev-identity-sms",
      "aws:SourceAccount": "123456789012",
    });
    expect(parsed.Statement[0]?.Condition?.ArnLike?.["aws:SourceArn"]).toBe(
      "arn:aws:cognito-idp:us-east-1:123456789012:userpool/*",
    );
    expect(smsConfig?.externalId).toBe("boxalarm-dev-identity-sms");
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
