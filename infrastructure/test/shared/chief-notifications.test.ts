import { describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ChiefNotificationTopic } from "../../components/shared/chief-notifications";
import { installMocks, resourcesOfType, settle } from "../alerting/mock-harness";

const topicArn = (env: string) =>
  `arn:aws:sns:us-east-1:123456789012:boxalarm-${env}-chief-notifications`;

async function build(env = "dev") {
  const topic = new ChiefNotificationTopic("chief-notifications", { env });
  await settle();
  return topic;
}

describe("ChiefNotificationTopic — subscription (deploy-readiness M2)", { timeout: 30_000 }, () => {
  it("subscribes the configured chiefNotificationEmail", async () => {
    installMocks({ "boxalarm-infra:chiefNotificationEmail": "chief@example.test" });
    await build();
    const subscriptions = resourcesOfType("aws:sns/topicSubscription:TopicSubscription").filter(
      (s) => s.inputs.topic === topicArn("dev"),
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.inputs).toMatchObject({
      protocol: "email",
      endpoint: "chief@example.test",
    });
  });

  it("warns, and subscribes nobody, when the email is unset outside prod", async () => {
    installMocks();
    const warn = vi.spyOn(pulumi.log, "warn");
    await build();
    expect(resourcesOfType("aws:sns/topicSubscription:TopicSubscription")).toHaveLength(0);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes("chiefNotificationEmail")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("fails preview in prod when the email is unset", async () => {
    installMocks({ "boxalarm-infra:env": "prod" });
    await expect(build("prod")).rejects.toThrow(/chiefNotificationEmail is required in prod/);
  });
});
