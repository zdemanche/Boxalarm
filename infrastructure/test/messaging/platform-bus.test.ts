import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:cloudwatch/eventBus:EventBus") {
        state.arn = `arn:aws:events:us-east-1:123456789012:event-bus/${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("PlatformBus", () => {
  it("names the bus boxalarm-{env}-platform-bus — the cross-batch pinned literal", async () => {
    const { PlatformBus } = await import("../../components/messaging/platform-bus");
    const bus = new PlatformBus("test-bus", { env: "dev" });

    expect(await resolve(bus.busName)).toBe("boxalarm-dev-platform-bus");
    expect(await resolve(bus.busArn)).toBe(
      "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus",
    );
  });

  it("throws on absent or unknown env", async () => {
    const { PlatformBus } = await import("../../components/messaging/platform-bus");
    expect(() => new PlatformBus("test-bus-bad", { env: "" })).toThrow(/env is required/);
  });
});
