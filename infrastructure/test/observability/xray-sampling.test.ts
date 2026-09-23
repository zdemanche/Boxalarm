import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: args.inputs,
    }),
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

describe("createDefaultSamplingRule", () => {
  it("provisions a platform-default rule with a low fixed rate and reservoir", async () => {
    const { createDefaultSamplingRule } =
      await import("../../components/observability/xray-sampling");
    const rule = createDefaultSamplingRule("prod");
    const [ruleName, priority, fixedRate, reservoirSize, serviceType, urlPath] = await new Promise<
      [
        string | undefined,
        number | undefined,
        number | undefined,
        number | undefined,
        string | undefined,
        string | undefined,
      ]
    >((resolve) =>
      pulumi
        .all([
          rule.ruleName,
          rule.priority,
          rule.fixedRate,
          rule.reservoirSize,
          rule.serviceType,
          rule.urlPath,
        ])
        .apply(resolve),
    );
    expect(ruleName).toBe("boxalarm-prod-default-sampling");
    expect(priority).toBe(1000);
    expect(fixedRate).toBe(0.05);
    expect(reservoirSize).toBe(1);
    expect(serviceType).toBe("*");
    expect(urlPath).toBe("*");
  });

  it("throws on empty env", async () => {
    const { createDefaultSamplingRule } =
      await import("../../components/observability/xray-sampling");
    expect(() => createDefaultSamplingRule("")).toThrow(/env is required/);
  });

  it("throws on wrong-typed env", async () => {
    const { createDefaultSamplingRule } =
      await import("../../components/observability/xray-sampling");
    expect(() => createDefaultSamplingRule({} as unknown as string)).toThrow(/env is required/);
  });
});

describe("createAlertingSamplingRule", () => {
  it("traces the alerting plane at 100%, at a higher priority than the LOB default", async () => {
    const { createDefaultSamplingRule, createAlertingSamplingRule } =
      await import("../../components/observability/xray-sampling");
    const defaultRule = createDefaultSamplingRule("prod");
    const alertingRule = createAlertingSamplingRule("prod");
    const [
      alertingName,
      alertingPriority,
      alertingFixedRate,
      alertingServiceName,
      defaultPriority,
    ] = await new Promise<
      [
        string | undefined,
        number | undefined,
        number | undefined,
        string | undefined,
        number | undefined,
      ]
    >((resolve) =>
      pulumi
        .all([
          alertingRule.ruleName,
          alertingRule.priority,
          alertingRule.fixedRate,
          alertingRule.serviceName,
          defaultRule.priority,
        ])
        .apply(resolve),
    );
    expect(alertingName).toBe("boxalarm-prod-alerting-sampling");
    expect(alertingFixedRate).toBe(1.0);
    expect(alertingPriority).toBeLessThan(defaultPriority as number);
    expect(alertingServiceName).toBe("boxalarm-prod-alerting-service-*");
  });

  it("throws on empty env", async () => {
    const { createAlertingSamplingRule } =
      await import("../../components/observability/xray-sampling");
    expect(() => createAlertingSamplingRule("")).toThrow(/env is required/);
  });
});

describe("ACTIVE_TRACING_CONFIG", () => {
  it("enables Active mode for future Lambda tracingConfig", async () => {
    const { ACTIVE_TRACING_CONFIG } = await import("../../components/observability/xray-sampling");
    expect(ACTIVE_TRACING_CONFIG).toEqual({ mode: "Active" });
  });
});
