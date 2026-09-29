import { beforeEach, describe, expect, it } from "vitest";
import {
  BOUNDARY_ARN,
  STACK_CONFIG,
  TABLE_ARN,
  buildSchedulingChain,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settleStack,
  statementsForRole,
} from "./mock-harness";

const INGRESS = "boxalarm-dev-alerting-dispatches-create";

beforeEach(() => {
  installMocks();
});

describe(
  "RoutesCore dispatch-ingress IAM matches runFanOut's DynamoDB calls",
  { timeout: 30_000 },
  () => {
    it.each([
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:TransactWriteItems",
      "dynamodb:PutItem",
      // The tone-ladder times (nextToneAt) written after the tone-2/3 schedules.
      "dynamodb:UpdateItem",
    ])("grants %s on the alerting table", async (action) => {
      await buildSchedulingChain();
      expect(isGranted(statementsForRole(INGRESS), action, TABLE_ARN)).toBe(true);
    });
  },
);

describe("RoutesCore active-dispatch list route", { timeout: 30_000 }, () => {
  const LIST = "boxalarm-dev-alerting-dispatches-list-active";

  it("grants Query on GSI2 only — no base-table read, no write, no Scan", async () => {
    await buildSchedulingChain();
    const statements = statementsForRole(LIST);
    expect(isGranted(statements, "dynamodb:Query", `${TABLE_ARN}/index/GSI2`)).toBe(true);
    const dynamoActions = statements
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a) => a.startsWith("dynamodb:"));
    expect(dynamoActions).toEqual(["dynamodb:Query"]);
    expect(isGranted(statements, "dynamodb:Query", TABLE_ARN)).toBe(false);
    expect(isGranted(statements, "dynamodb:Query", (r) => r.includes("platform"))).toBe(false);
  });

  it("sets every env var the handler reads and the alerting permissions boundary", async () => {
    await buildSchedulingChain();
    expect(lambdaEnv(LIST)).toMatchObject({
      ALERTING_TABLE_NAME: "boxalarm-dev-alerting-table",
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: "policy-store-id",
    });
    const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === LIST);
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("routes GET /api/v1/alerting/dispatches through the authorizer", async () => {
    await buildSchedulingChain();
    const route = resourcesOfType("aws:apigatewayv2/route:Route").find(
      (r) => r.inputs.routeKey === "GET /api/v1/alerting/dispatches",
    );
    expect(route?.inputs.authorizationType).toBe("CUSTOM");
  });
});

describe("RoutesCore dispatch-detail route (pre-plan context reads)", { timeout: 30_000 }, () => {
  const DETAIL = "boxalarm-dev-alerting-dispatch-detail";

  it("adds only Query on the copy indexes (GSI1 address, GSI2 geohash) to its base-table reads", async () => {
    await buildSchedulingChain();
    const statements = statementsForRole(DETAIL);
    expect(isGranted(statements, "dynamodb:Query", `${TABLE_ARN}/index/GSI1`)).toBe(true);
    expect(isGranted(statements, "dynamodb:Query", `${TABLE_ARN}/index/GSI2`)).toBe(true);
    expect(isGranted(statements, "dynamodb:GetItem", TABLE_ARN)).toBe(true);
    const dynamoActions = new Set(
      statements
        .filter((s) => s.Effect === "Allow")
        .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
        .filter((a) => a.startsWith("dynamodb:")),
    );
    // Read-only: enrichment never writes, and never Scans.
    expect([...dynamoActions].sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    const resources = statements.flatMap((s) =>
      Array.isArray(s.Resource) ? s.Resource : [s.Resource],
    );
    expect(resources.filter((r) => r.includes(":table/"))).toEqual(
      expect.arrayContaining([TABLE_ARN, `${TABLE_ARN}/index/GSI1`, `${TABLE_ARN}/index/GSI2`]),
    );
    expect(resources.some((r) => /:table\/(?!boxalarm-dev-alerting-table)/.test(r))).toBe(false);
  });
});

describe("home locality for pre-plan address verification (round-2 A)", () => {
  it("defaults tenant zero to Trumbull and its villages / 06611, and validates an override", async () => {
    const { resolveHomeLocality } = await import("../../components/alerting/home-locality");
    expect(JSON.parse(resolveHomeLocality("nichols-fd", undefined) ?? "null")).toEqual({
      towns: ["Trumbull", "Nichols", "Long Hill", "Trumbull Center"],
      zips: ["06611"],
      state: "CT",
    });
    expect(resolveHomeLocality("other-fd", undefined)).toBeUndefined();
    expect(
      JSON.parse(resolveHomeLocality("other-fd", '{"towns":["Monroe"],"zips":["06468"]}') ?? ""),
    ).toEqual({ towns: ["Monroe"], zips: ["06468"] });
    expect(() => resolveHomeLocality("x", '{"town":"Monroe"}')).toThrow(/towns/);
  });

  it(
    "the full stack gives the dispatch-detail Lambda ALERTING_HOME_LOCALITY",
    { timeout: 120_000 },
    async () => {
      installMocks(STACK_CONFIG);
      await import("../../index");
      await settleStack();
      const env = lambdaEnv("boxalarm-dev-alerting-dispatch-detail");
      expect(JSON.parse(env.ALERTING_HOME_LOCALITY ?? "null")).toMatchObject({
        towns: expect.arrayContaining(["Trumbull", "Nichols"]) as unknown,
        zips: ["06611"],
      });
    },
  );
});

describe("RoutesCore home-locality route (round-3 R3-A)", { timeout: 30_000 }, () => {
  const FN = "boxalarm-dev-alerting-home-locality";

  it("serves GET /api/v1/alerting/home-locality with a GetItem limited to the CONFIG partition", async () => {
    await buildSchedulingChain();
    const route = resourcesOfType("aws:apigatewayv2/route:Route").find(
      (r) => r.inputs.routeKey === "GET /api/v1/alerting/home-locality",
    );
    expect(route).toBeDefined();
    const statements = statementsForRole(FN);
    const dynamo = statements.filter(
      (s) => s.Effect === "Allow" && [s.Action].flat().some((a) => a.startsWith("dynamodb:")),
    );
    expect(dynamo).toEqual([
      expect.objectContaining({
        Action: ["dynamodb:GetItem"],
        Resource: TABLE_ARN,
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CONFIG"] } },
      }),
    ]);
    const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === FN);
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });
});
