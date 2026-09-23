import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: args.inputs,
    }),
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
  });
});

type ExpressionEntry = [{ expression: string; id: string; label?: string; visible?: boolean }];

function findWidget(
  body: { widgets: Array<{ properties: { title: string; metrics: unknown[][] } }> },
  titlePattern: RegExp,
) {
  const widget = body.widgets.find((w) => titlePattern.test(w.properties.title));
  if (!widget) throw new Error(`no widget matching ${titlePattern}`);
  return widget;
}

function metricRow(widget: { properties: { metrics: unknown[][] } }, id: string) {
  const row = widget.properties.metrics.find((m) => (m as ExpressionEntry)[0]?.id === id) as
    ExpressionEntry | undefined;
  if (!row) throw new Error(`no metric row with id ${id}`);
  return row[0];
}

describe("ServiceDashboard", () => {
  it("emits error-rate, latency, and throughput widgets for a known service", async () => {
    const { ServiceDashboard } = await import("../../components/observability/service-dashboard");
    const dashboard = new ServiceDashboard("test-dash", {
      env: "prod",
      serviceName: "personnel-service",
    });
    const [dashboardName, bodyJson] = await new Promise<[string, string]>((resolve) =>
      pulumi
        .all([dashboard.dashboard.dashboardName, dashboard.dashboard.dashboardBody])
        .apply(resolve),
    );
    expect(dashboardName).toBe("boxalarm-prod-personnel-service");
    const body = JSON.parse(bodyJson) as {
      widgets: Array<{ properties: { title: string; metrics: unknown[][] } }>;
    };
    expect(body.widgets).toHaveLength(3);
    const titles = body.widgets.map((w) => w.properties.title);
    expect(titles.some((t) => /error rate/i.test(t))).toBe(true);
    expect(titles.some((t) => /latency/i.test(t))).toBe(true);
    expect(titles.some((t) => /throughput/i.test(t))).toBe(true);

    const errorRateWidget = findWidget(body, /error rate/i);
    const errorsSearch = metricRow(errorRateWidget, "errorsSearch");
    expect(errorsSearch.expression).toBe(
      "SEARCH('{AWS/Lambda,FunctionName} MetricName=\"Errors\" FunctionName=boxalarm-prod-personnel-service-', 'Sum', 60)",
    );
    expect(errorsSearch.visible).toBe(false);
    const errorsSum = metricRow(errorRateWidget, "errors");
    expect(errorsSum.expression).toBe("SUM(errorsSearch)");

    const invocationsSearch = metricRow(errorRateWidget, "invocationsSearch");
    expect(invocationsSearch.expression).toBe(
      "SEARCH('{AWS/Lambda,FunctionName} MetricName=\"Invocations\" FunctionName=boxalarm-prod-personnel-service-', 'Sum', 60)",
    );
    const invocationsSum = metricRow(errorRateWidget, "invocations");
    expect(invocationsSum.expression).toBe("SUM(invocationsSearch)");

    const errorRate = metricRow(errorRateWidget, "errorRate");
    expect(errorRate.expression).toBe("(errors / invocations) * 100");

    const latencyWidget = findWidget(body, /latency/i);
    const durationSearch = metricRow(latencyWidget, "durationSearch");
    expect(durationSearch.expression).toBe(
      "SEARCH('{AWS/Lambda,FunctionName} MetricName=\"Duration\" FunctionName=boxalarm-prod-personnel-service-', 'p99', 60)",
    );
    const durationAggregate = metricRow(latencyWidget, "duration");
    expect(durationAggregate.expression).toBe("AVERAGE(durationSearch)");

    const throughputWidget = findWidget(body, /throughput/i);
    const throughputSearch = metricRow(throughputWidget, "throughputSearch");
    expect(throughputSearch.expression).toBe(
      "SEARCH('{AWS/Lambda,FunctionName} MetricName=\"Invocations\" FunctionName=boxalarm-prod-personnel-service-', 'Sum', 60)",
    );
    const throughputAggregate = metricRow(throughputWidget, "throughput");
    expect(throughputAggregate.expression).toBe("SUM(throughputSearch)");
  });

  it("throws for a serviceName outside the known service inventory", async () => {
    const { ServiceDashboard } = await import("../../components/observability/service-dashboard");
    expect(
      () =>
        new ServiceDashboard("test-dash-bad", {
          env: "prod",
          serviceName: "made-up-service" as never,
        }),
    ).toThrow(/unknown serviceName/);
  });

  it("throws on absent env", async () => {
    const { ServiceDashboard } = await import("../../components/observability/service-dashboard");
    expect(
      () =>
        new ServiceDashboard("test-dash-no-env", {
          env: "",
          serviceName: "alerting-service",
        }),
    ).toThrow(/env is required/);
  });
});
