import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resourcesOfType, settleStack } from "./mock-harness";

describe("full stack: no alerting alarm pages nobody", { timeout: 120_000 }, () => {
  it("every boxalarm-*-alerting-* alarm has at least one alarm action", async () => {
    installMocks(STACK_CONFIG);
    await import("../../index");
    await settleStack();

    const alerting = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm").filter((a) =>
      String(a.inputs.name).includes("-alerting-"),
    );
    expect(alerting.length).toBeGreaterThan(10);
    const silent = alerting
      .filter((a) => !Array.isArray(a.inputs.alarmActions) || a.inputs.alarmActions.length === 0)
      .map((a) => a.inputs.name);
    expect(silent).toEqual([]);
  });
});
