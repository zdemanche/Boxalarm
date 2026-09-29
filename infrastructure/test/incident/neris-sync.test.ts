import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";

const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-incident-service";
const CMK_ARN = "arn:aws:kms:us-east-1:123456789012:key/incident-cmk";
const CREDENTIALS_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:boxalarm-dev-neris-client-credentials";

const schedules: Record<string, Record<string, unknown>> = {};

beforeEach(() => {
  for (const key of Object.keys(schedules)) delete schedules[key];
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
      if (args.type === "aws:scheduler/schedule:Schedule") {
        schedules[String(args.inputs.name)] = args.inputs;
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

describe("NerisSync", () => {
  async function build() {
    const { NerisSync } = await import("../../components/incident/neris-sync");
    const logGroup = new ServiceLogGroup("test-neris-sync-lg", {
      env: "dev",
      serviceName: "incident-service",
    });
    return new NerisSync("test-neris-sync", {
      env: "dev",
      deptId: "NICHOLS",
      incidentTableName: pulumi.output("boxalarm-dev-incident-service"),
      incidentTableArn: pulumi.output(TABLE_ARN),
      incidentCmkArn: pulumi.output(CMK_ARN),
      nerisCredentialsSecretArn: pulumi.output(CREDENTIALS_ARN),
      logGroup,
    });
  }

  it("schedules the status poller every 5 minutes and reconciliation nightly in New York time", async () => {
    const sync = await build();
    await resolve(sync.lambdas["neris-reconciliation"].function.arn);
    await new Promise((r) => setImmediate(r));
    expect(schedules["boxalarm-dev-incident-neris-status-poller"]).toMatchObject({
      scheduleExpression: "rate(5 minutes)",
      flexibleTimeWindow: { mode: "OFF" },
    });
    expect(schedules["boxalarm-dev-incident-neris-reconciliation"]).toMatchObject({
      scheduleExpression: "cron(15 3 * * ? *)",
      scheduleExpressionTimezone: "America/New_York",
    });
  });

  it("gives both jobs the department to sweep and the NERIS config they read", async () => {
    const sync = await build();
    for (const lambda of Object.values(sync.lambdas)) {
      const env = await resolve(lambda.function.environment);
      expect(env?.variables).toMatchObject({
        INCIDENT_TABLE_NAME: "boxalarm-dev-incident-service",
        NERIS_SCANNER_DEPT_ID: "NICHOLS",
        NERIS_BASE_URL_PARAM: "/boxalarm/dev/neris/base-url",
        NERIS_USER_AGENT_PARAM: "/boxalarm/dev/neris/user-agent",
        NERIS_CREDENTIALS_SECRET_ID: CREDENTIALS_ARN,
        BOXALARM_ENV: "dev",
      });
    }
  });

  it("scopes each job's table access to what its handler does", async () => {
    const sync = await build();
    const poller = JSON.parse(
      await resolve(sync.lambdas["neris-status-poller"].rolePolicy.policy),
    ) as PolicyDoc;
    expect(poller.Statement.find((s) => s.Sid === "NerisStatusPollAccess")).toMatchObject({
      Action: [
        "dynamodb:Query",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
      ],
      Resource: [TABLE_ARN],
    });
    const reconciliation = JSON.parse(
      await resolve(sync.lambdas["neris-reconciliation"].rolePolicy.policy),
    ) as PolicyDoc;
    expect(
      reconciliation.Statement.find((s) => s.Sid === "NerisReconciliationAccess"),
    ).toMatchObject({
      Action: ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: [TABLE_ARN, `${TABLE_ARN}/index/GSI1`],
    });
  });

  it("lets the scheduler role invoke only the two NERIS jobs", async () => {
    const sync = await build();
    const trust = JSON.parse(await resolve(sync.schedulerRole.assumeRolePolicy)) as {
      Statement: Array<{ Principal: { Service: string } }>;
    };
    expect(trust.Statement[0]!.Principal.Service).toBe("scheduler.amazonaws.com");
  });
});
