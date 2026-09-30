import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resourcesOfType, settleStack } from "../alerting/mock-harness";

const scheduleState = () =>
  resourcesOfType("aws:scheduler/schedule:Schedule").find(
    (s) => s.inputs.name === "boxalarm-dev-incident-neris-schema-refresh",
  )?.inputs.state;

/** Review F6: dev's placeholder schema URL must not fail (and email the ops topic) daily. */
describe("NERIS schema refresh on a placeholder source", { timeout: 120_000 }, () => {
  it("is scheduled DISABLED while the URL is a placeholder", async () => {
    installMocks({
      ...STACK_CONFIG,
      "boxalarm-infra:nerisSchemaSourceUrl":
        "https://neris-schema-source.invalid/neris/schema.json",
    });
    await import("../../index");
    await settleStack();
    expect(scheduleState()).toBe("DISABLED");
  });
});
