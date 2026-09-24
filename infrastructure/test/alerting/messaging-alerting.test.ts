import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

function mockResources(onSubscription?: (name: string, filterPolicy: string) => void) {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
        state.url = `https://sqs.us-east-1.amazonaws.com/123456789012/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sns/topic:Topic") {
        state.arn = `arn:aws:sns:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sns/topicSubscription:TopicSubscription") {
        onSubscription?.(args.name, args.inputs.filterPolicy as string);
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
}

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("MessagingAlerting", () => {
  it("names the FIFO topic with content-based dedup off (publisher sets MessageDeduplicationId)", async () => {
    mockResources();
    const { MessagingAlerting } = await import("../../components/alerting/messaging-alerting");
    const messaging = new MessagingAlerting("messaging", { env: "dev" });
    const [name, fifo, dedup] = await Promise.all([
      resolve(messaging.topic.name),
      resolve(messaging.topic.fifoTopic),
      resolve(messaging.topic.contentBasedDeduplication),
    ]);
    expect(name).toBe("boxalarm-dev-alerting-topic.fifo");
    expect(fifo).toBe(true);
    expect(dedup).toBe(false);
  });

  it("filters each channel subscription on `channel` only — never channelTier or toneSequence", async () => {
    const filterPolicies: Record<string, unknown>[] = [];
    mockResources((_name, filterPolicy) => filterPolicies.push(JSON.parse(filterPolicy)));
    const { MessagingAlerting } = await import("../../components/alerting/messaging-alerting");
    const messaging = new MessagingAlerting("messaging-filters", { env: "dev" });
    await Promise.all(
      (["push", "sms", "voice"] as const).map((channel) =>
        resolve(messaging.channelQueues[channel].queue.arn),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(filterPolicies).toHaveLength(3);
    for (const policy of filterPolicies) {
      expect(Object.keys(policy)).toEqual(["channel"]);
    }
    const channels = filterPolicies.map((p) => (p.channel as string[])[0]).sort();
    expect(channels).toEqual(["push", "sms", "voice"]);
  });

  it("gives each channel queue a DLQ with maxReceiveCount 3", async () => {
    mockResources();
    const { MessagingAlerting } = await import("../../components/alerting/messaging-alerting");
    const messaging = new MessagingAlerting("messaging-dlq", { env: "dev" });
    for (const channel of ["push", "sms", "voice"] as const) {
      const redrivePolicy = await resolve(messaging.channelQueues[channel].queue.redrivePolicy);
      const parsed = JSON.parse(redrivePolicy as unknown as string) as {
        maxReceiveCount: number;
      };
      expect(parsed.maxReceiveCount).toBe(3);
      const dlqName = await resolve(messaging.channelQueues[channel].dlq.name);
      expect(dlqName).toBe(`boxalarm-dev-alerting-${channel}-dlq.fifo`);
    }
  });

  // FIFO head-of-line blocking (MAJOR): the backend publisher sets
  // MessageGroupId: dispatchId, so every member of one dispatch on one channel shares a
  // FIFO group and a stuck member blocks every later member for up to
  // maxReceiveCount(3) x visibilityTimeoutSeconds. This pins the documented 2x-worker-
  // timeout formula so a future change to the multiplier is deliberate, not accidental —
  // see the analysis comment in messaging-alerting.ts for why neither a smaller
  // multiplier nor an infra-side MessageGroupId change was made here.
  it("sizes queue visibility at exactly 2x the worker timeout (documented FIFO head-of-line trade-off)", async () => {
    mockResources();
    const { MessagingAlerting } = await import("../../components/alerting/messaging-alerting");
    const messaging = new MessagingAlerting("messaging-visibility", {
      env: "dev",
      workerTimeoutSeconds: 20,
    });
    for (const channel of ["push", "sms", "voice"] as const) {
      const visibility = await resolve(
        messaging.channelQueues[channel].queue.visibilityTimeoutSeconds,
      );
      expect(visibility).toBe(40);
    }
  });
});
