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

describe("ServiceLogGroup", () => {
  it.each([
    ["dev", 14],
    ["qa", 14],
    ["staging", 30],
    ["prod", 90],
  ])(
    "retains %s logs for %d days under the agreed one-group-per-service literal",
    async (env, expected) => {
      const { ServiceLogGroup, serviceLogGroupName } =
        await import("../../components/observability/service-log-group");
      const group = new ServiceLogGroup("test-lg", { env, serviceName: "alerting-service" });
      const expectedName = serviceLogGroupName(env, "alerting-service");
      expect(expectedName).toBe(`/aws/lambda/boxalarm-${env}-alerting-service`);
      expect(group.logGroupName).toBe(expectedName);
      const [name, retention] = await new Promise<[string | undefined, number | undefined]>(
        (resolve) =>
          pulumi.all([group.logGroup.name, group.logGroup.retentionInDays]).apply(resolve),
      );
      expect(name).toBe(expectedName);
      expect(retention).toBe(expected);
      expect(retention).not.toBe(0);
    },
  );

  it("throws rather than provisioning a never-expire log group for an unknown env", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    expect(
      () =>
        new ServiceLogGroup("test-lg-bad-env", {
          env: "production",
          serviceName: "alerting-service",
        }),
    ).toThrow(/unknown env/);
  });

  it("throws for a serviceName outside the known service inventory", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    expect(
      () =>
        new ServiceLogGroup("test-lg-bad-service", {
          env: "dev",
          serviceName: "made-up-service" as never,
        }),
    ).toThrow(/unknown serviceName/);
  });

  it("throws on absent env", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    expect(
      () =>
        new ServiceLogGroup("test-lg-no-env", {
          env: undefined as unknown as string,
          serviceName: "alerting-service",
        }),
    ).toThrow(/env is required/);
  });
});
