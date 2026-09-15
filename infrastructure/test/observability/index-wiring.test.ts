import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { SERVICES } from "../../components/observability/services";

describe("index.ts production wiring", () => {
  let counts: Record<string, number>;
  let logGroupNames: Set<string>;
  let dashboardNames: Set<string>;

  beforeEach(async () => {
    vi.resetModules();
    counts = {};
    logGroupNames = new Set();
    dashboardNames = new Set();
    await pulumi.runtime.setMocks(
      {
        newResource: (args: pulumi.runtime.MockResourceArgs) => {
          counts[args.type] = (counts[args.type] ?? 0) + 1;
          if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
            logGroupNames.add(args.inputs.name as string);
          }
          if (args.type === "aws:cloudwatch/dashboard:Dashboard") {
            dashboardNames.add(args.inputs.dashboardName as string);
          }
          return { id: `${args.name}-id`, state: args.inputs };
        },
        call: (args: pulumi.runtime.MockCallArgs) => {
          if (args.token === "aws:index/getRegion:getRegion") {
            return {
              name: "us-east-1",
              region: "us-east-1",
              id: "us-east-1",
              description: "US East (N. Virginia)",
              endpoint: "",
            };
          }
          return args.inputs;
        },
      },
      "boxalarm-infra",
      "dev",
    );
    pulumi.runtime.setAllConfig({ "boxalarm-infra:env": "dev" });
  });

  it("provisions a log group and dashboard for every service, and both sampling rules", async () => {
    const indexModule = await import("../../index");
    await new Promise<void>((resolve) =>
      pulumi.all(indexModule.serviceLogGroups.map((g) => g.logGroup.urn)).apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      pulumi.all(indexModule.serviceDashboards.map((d) => d.dashboard.urn)).apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      indexModule.defaultSamplingRule.urn.apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      indexModule.alertingSamplingRule.urn.apply(() => resolve()),
    );
    // boxalarm-docs#115 identity infra (pre-token-generation trigger + both app
    // clients) settles here too, so its registerOutputs doesn't fire after this
    // file's next beforeEach has already swapped in a fresh mock monitor.
    await new Promise<void>((resolve) =>
      pulumi
        .all([
          indexModule.identity.userPool.id,
          indexModule.identity.preTokenGenerationFunction.arn,
          indexModule.identity.functionRole.arn,
          indexModule.identity.functionLogGroup.arn,
          indexModule.identity.invokePermission.id,
          indexModule.mobileUserPoolClient.userPoolClient.id,
          indexModule.webUserPoolClient.userPoolClient.id,
        ])
        .apply(() => resolve()),
    );

    // 10 services + the identity pre-token-generation trigger's own log group.
    expect(counts["aws:cloudwatch/logGroup:LogGroup"]).toBe(11);
    expect(counts["aws:cloudwatch/dashboard:Dashboard"]).toBe(10);
    expect(counts["aws:xray/samplingRule:SamplingRule"]).toBe(2);
    expect(indexModule.stack).toBe("dev");
    expect(indexModule.env).toBe("dev");

    const expectedLogGroupNames = new Set([
      ...SERVICES.map((serviceName) => `/aws/lambda/boxalarm-dev-${serviceName}`),
      "/aws/lambda/boxalarm-dev-identity-pre-token-generation",
    ]);
    const expectedDashboardNames = new Set(
      SERVICES.map((serviceName) => `boxalarm-dev-${serviceName}`),
    );
    expect(logGroupNames).toEqual(expectedLogGroupNames);
    expect(dashboardNames).toEqual(expectedDashboardNames);
  });

  it("throws when the boxalarm-infra:env config key is not declared", async () => {
    pulumi.runtime.setAllConfig({});
    await expect(import("../../index")).rejects.toThrow(/boxalarm-infra:env/);
  });
});
