import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resourcesOfType, settleStack } from "../alerting/mock-harness";

describe("NERIS schema refresh on a real source", { timeout: 120_000 }, () => {
  it("is scheduled ENABLED", async () => {
    installMocks({
      ...STACK_CONFIG,
      "boxalarm-infra:nerisSchemaSourceUrl": "https://schemas.nicholsfd.org/neris/schema.json",
    });
    await import("../../index");
    await settleStack();
    const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
      (s) => s.inputs.name === "boxalarm-dev-incident-neris-schema-refresh",
    );
    expect(schedule?.inputs.state).toBe("ENABLED");
  });
});
