import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

interface PolicyStatement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string[]>>;
}

let rolePolicyByName: Record<string, string>;
let functionEnvironmentByName: Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.resetModules();
  rolePolicyByName = {};
  functionEnvironmentByName = {};
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
        const env = args.inputs.environment as { variables?: Record<string, unknown> } | undefined;
        functionEnvironmentByName[args.name] = env?.variables ?? {};
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:scheduler/scheduleGroup:ScheduleGroup") {
        state.arn = `arn:aws:scheduler:us-east-1:123456789012:schedule-group/${args.inputs.name}`;
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

function hasStatement(
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

async function buildFixture() {
  const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
  const { HttpApi } = await import("../../components/api/http-api");
  const { Escalation } = await import("../../components/alerting/escalation");
  const { FanOut } = await import("../../components/alerting/fan-out");
  const { RoutesCore } = await import("../../components/alerting/routes-core");

  const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const platformLogGroup = new ServiceLogGroup("platform-lg", {
    env: "dev",
    serviceName: "platform-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup,
  });

  const escalation = new Escalation("escalation", {
    env: "dev",
    alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
    alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup: alertingLogGroup,
  });

  const fanOut = new FanOut("fan-out", {
    env: "dev",
    alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingStreamArn:
      "arn:aws:dynamodb:us-east-1:123456789012:table/alerting/stream/2026-01-01T00:00:00.000",
    alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
    alertingTableCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
    logGroup: alertingLogGroup,
  });

  const routesCore = new RoutesCore("routes-core", {
    env: "dev",
    httpApi,
    alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup: alertingLogGroup,
    escalation,
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return { escalation, fanOut, routesCore };
}

describe("voice escalation scheduling is wired to the dispatch-ingress Lambda, not fan-out", () => {
  it("grants scheduler:CreateSchedule and iam:PassRole (scoped, PassedToService=scheduler) on the dispatch-ingress role, not fan-out", async () => {
    await buildFixture();

    const ingressStatements = statementsFor("routes-core-dispatch-ingress-fn-role-policy");
    expect(
      hasStatement(ingressStatements, "scheduler:CreateSchedule", (r) => r.includes("schedule/")),
    ).toBe(true);
    expect(
      hasStatement(ingressStatements, "iam:PassRole", (r) =>
        r.includes("alerting-escalation-scheduler"),
      ),
    ).toBe(true);
    const passRoleStatement = ingressStatements.find((s) => s.Sid === "PassSchedulerRoleOnly")!;
    expect(passRoleStatement.Condition).toEqual({
      StringEquals: { "iam:PassedToService": ["scheduler.amazonaws.com"] },
    });

    const fanOutStatements = statementsFor("fan-out-fn-role-policy");
    expect(fanOutStatements.some((s) => s.Sid === "CreateEscalationSchedulesOnly")).toBe(false);
    expect(fanOutStatements.some((s) => s.Sid === "PassSchedulerRoleOnly")).toBe(false);
  });

  it("grants the dispatch-ingress role dynamodb:Query and dynamodb:GetItem on the alerting table for its roster/threshold reads", async () => {
    await buildFixture();

    const ingressStatements = statementsFor("routes-core-dispatch-ingress-fn-role-policy");
    const tableArn = "arn:aws:dynamodb:us-east-1:123456789012:table/alerting";
    expect(hasStatement(ingressStatements, "dynamodb:Query", (r) => r === tableArn)).toBe(true);
    expect(hasStatement(ingressStatements, "dynamodb:GetItem", (r) => r === tableArn)).toBe(true);
  });

  it("wires ESCALATION_HANDLER_ARN and ESCALATION_SCHEDULER_ROLE_ARN onto the dispatch-ingress Lambda only", async () => {
    await buildFixture();

    const ingressEnv = functionEnvironmentByName["routes-core-dispatch-ingress-fn-fn"];
    expect(ingressEnv).toBeDefined();
    expect(ingressEnv.ESCALATION_HANDLER_ARN).toContain("alerting-escalation");
    expect(ingressEnv.ESCALATION_SCHEDULER_ROLE_ARN).toContain("alerting-escalation-scheduler");

    const fanOutEnv = functionEnvironmentByName["fan-out-fn-fn"];
    expect(fanOutEnv).toBeDefined();
    expect(fanOutEnv.ESCALATION_HANDLER_ARN).toBeUndefined();
    expect(fanOutEnv.ESCALATION_SCHEDULER_ROLE_ARN).toBeUndefined();
  });
});
