import * as path from "path";
import { describe, expect, it } from "vitest";

/** scripts/check-alarm-subscriptions.mjs against a mocked SNS client (deploy-readiness M3). */
type Command = { constructor: { name: string }; input: Record<string, string | undefined> };
interface CheckModule {
  checkAlarmSubscriptions(
    sns: { send: (command: Command) => Promise<unknown> },
    env: string,
  ): Promise<{ problems: string[]; ok: string[] }>;
}

const SCRIPT = path.resolve(__dirname, "../../scripts/check-alarm-subscriptions.mjs");
const load = async () => (await import(SCRIPT)) as CheckModule;
const arn = (name: string) => `arn:aws:sns:us-east-1:123456789012:${name}`;

type Sub = { SubscriptionArn: string; Protocol: string; Endpoint: string };
const confirmed = (endpoint: string): Sub => ({
  SubscriptionArn: `${arn("x")}:sub-1`,
  Protocol: "email",
  Endpoint: endpoint,
});
const pending = (endpoint: string): Sub => ({
  SubscriptionArn: "PendingConfirmation",
  Protocol: "email",
  Endpoint: endpoint,
});

function sns(subscriptionsByTopic: Record<string, Sub[]>) {
  return {
    send: async (command: Command) => {
      if (command.constructor.name === "ListTopicsCommand") {
        // Two pages, to prove the script follows NextToken.
        const topics = Object.keys(subscriptionsByTopic).map((name) => ({ TopicArn: arn(name) }));
        return command.input.NextToken === undefined
          ? { Topics: [{ TopicArn: arn("unrelated") }], NextToken: "p2" }
          : { Topics: topics };
      }
      if (command.constructor.name === "ListSubscriptionsByTopicCommand") {
        const name = command.input.TopicArn!.split(":").pop()!;
        return { Subscriptions: subscriptionsByTopic[name] ?? [] };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}

describe("check-alarm-subscriptions.mjs", () => {
  it("passes when both alarm topics have only confirmed subscriptions", async () => {
    const { checkAlarmSubscriptions } = await load();
    const result = await checkAlarmSubscriptions(
      sns({
        "boxalarm-dev-alerting-page": [confirmed("oncall@x.test")],
        "boxalarm-dev-chief-notifications": [confirmed("chief@x.test")],
      }),
      "dev",
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toHaveLength(2);
  });

  it("fails loudly on a subscription still PendingConfirmation", async () => {
    const { checkAlarmSubscriptions } = await load();
    const { problems } = await checkAlarmSubscriptions(
      sns({
        "boxalarm-prod-alerting-page": [pending("oncall@x.test")],
        "boxalarm-prod-chief-notifications": [confirmed("chief@x.test")],
      }),
      "prod",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /alerting-page: email subscription for oncall@x.test is still PendingConfirmation/,
    );
  });

  it("fails on a topic with no subscription, and on a missing topic", async () => {
    const { checkAlarmSubscriptions } = await load();
    const { problems } = await checkAlarmSubscriptions(
      sns({ "boxalarm-qa-alerting-page": [] }),
      "qa",
    );
    expect(problems.join("\n")).toMatch(/alerting-page: no subscription/);
    expect(problems.join("\n")).toMatch(/chief-notifications: topic not found/);
  });
});
