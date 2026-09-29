import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PlatformBus } from "../../components/messaging/platform-bus";

const routeKeys: string[] = [];

beforeEach(() => {
  routeKeys.length = 0;
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
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      if (args.type === "aws:apigatewayv2/route:Route") {
        routeKeys.push(args.inputs.routeKey as string);
      }
      if (args.type === "aws:sqs/queue:Queue" || args.type === "aws:cloudwatch/eventBus:EventBus") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
        state.url = `https://sqs.us-east-1.amazonaws.com/123456789012/${args.name}`;
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

const POOL_ARN = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1";
const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/platform";

async function build() {
  const { SessionRevocation } = await import("../../components/identity/session-revocation");
  const platformLogGroup = new ServiceLogGroup("test-sr-log-group", {
    env: "dev",
    serviceName: "platform-service",
  });
  const httpApi = new HttpApi("test-sr-http-api", {
    env: "dev",
    userPoolId: pulumi.output("pool-1"),
    platformTableName: "platform-table",
    platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
    allowedClientIds: [pulumi.output("client-1")],
    platformLogGroup,
  });
  const platformBus = new PlatformBus("test-sr-bus", { env: "dev" });
  return new SessionRevocation("test-sr", {
    env: "dev",
    userPoolId: pulumi.output("pool-1"),
    userPoolArn: pulumi.output(POOL_ARN),
    policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
    policyStoreId: pulumi.output("ps-1"),
    platformLogGroup,
    httpApi,
    platformBus,
    platformTableName: pulumi.output("platform-table"),
    platformTableArn: pulumi.output(TABLE_ARN),
    chiefNotificationTopicArn: pulumi.output("arn:aws:sns:us-east-1:123456789012:chief"),
  });
}

interface Statement {
  Sid?: string;
  Action: string | string[];
  Resource: string | string[];
}

async function statementsOf(lambda: {
  rolePolicy: { policy: pulumi.Output<string> };
}): Promise<Statement[]> {
  return (JSON.parse(await resolve(lambda.rolePolicy.policy)) as { Statement: Statement[] })
    .Statement;
}

function actionsOn(statements: Statement[], resource: string): string[] {
  return statements
    .filter((s) => s.Resource === resource)
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

describe("SessionRevocation (review C1)", () => {
  it("lets the status consumer disable and re-enable logins, scoped to the one pool", async () => {
    const sr = await build();
    const actions = actionsOn(await statementsOf(sr.memberStatusLambda), POOL_ARN);

    expect(actions).toEqual(
      expect.arrayContaining([
        "cognito-idp:AdminDisableUser",
        "cognito-idp:AdminEnableUser",
        "cognito-idp:AdminUserGlobalSignOut",
      ]),
    );
  });

  it("gives the status consumer a read of member rows only, and the table name", async () => {
    const sr = await build();
    const statements = await statementsOf(sr.memberStatusLambda);
    const env = await resolve(sr.memberStatusLambda.function.environment);

    expect(env?.variables?.PLATFORM_TABLE_NAME).toBe("platform-table");
    expect(actionsOn(statements, TABLE_ARN)).toEqual(["dynamodb:GetItem", "dynamodb:PutItem"]);
  });

  // M1: every revocation path writes the marker the authorizer checks token iat against.
  it("lets every revocation path write the session revocation marker, and only that key", async () => {
    const sr = await build();
    for (const lambda of [sr.memberStatusLambda, sr.deviceLossLambda, sr.credentialResetLambda]) {
      const statements = await statementsOf(lambda);
      const marker = statements.find((s) => s.Sid === "WriteSessionRevocationMarker") as
        (Statement & { Condition: unknown }) | undefined;
      expect(marker?.Action).toEqual(["dynamodb:PutItem"]);
      expect(marker?.Condition).toEqual({
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#SESSION_REVOCATION#*"] },
      });
      const env = await resolve(lambda.function.environment);
      expect(env?.variables?.PLATFORM_TABLE_NAME).toBe("platform-table");
    }
  });

  it("wires the admin reset-password-and-sign-out route with only the calls it makes", async () => {
    const sr = await build();
    await resolve(sr.credentialResetLambda.function.arn);
    // Routes register once their integration id resolves; give the mock monitor a few turns.
    for (let i = 0; i < 20 && routeKeys.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    const actions = actionsOn(await statementsOf(sr.credentialResetLambda), POOL_ARN);

    expect(routeKeys).toContain("POST /api/v1/platform/sessions/reset-credentials");
    expect(actions).toEqual(
      expect.arrayContaining([
        "cognito-idp:AdminResetUserPassword",
        "cognito-idp:AdminUserGlobalSignOut",
      ]),
    );
    expect(actions).not.toContain("cognito-idp:AdminDisableUser");
  });

  it("alarms the chief on every credential reset (no threshold)", async () => {
    const sr = await build();
    const alarm = sr.credentialResetInvokedAlarm;
    const [metricName, threshold, actions] = await Promise.all([
      resolve(alarm.metricName),
      resolve(alarm.threshold),
      resolve(alarm.alarmActions),
    ]);

    expect(metricName).toBe("ResetMemberCredentialsInvoked");
    expect(threshold).toBe(0);
    expect(actions).toEqual(["arn:aws:sns:us-east-1:123456789012:chief"]);
  });

  // M2: the lost phone must stop getting dispatch pushes.
  it("lets device loss drop the member's PUSH channel and emit the outbox event, key-scoped", async () => {
    const sr = await build();
    const statements = (await statementsOf(sr.deviceLossLambda)) as Array<
      Statement & { Condition?: unknown }
    >;
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));

    expect(bySid.InvalidateMemberPush?.Action).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(bySid.InvalidateMemberPush?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#MEMBER#*"] },
    });
    expect(bySid.EmitMemberUpdatedOutbox?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#OUTBOX#*"] },
    });
    expect(bySid.TransactPushInvalidation?.Action).toEqual(["dynamodb:TransactWriteItems"]);
  });
});
