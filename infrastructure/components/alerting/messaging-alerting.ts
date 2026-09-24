import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export type AlertingChannel = "push" | "sms" | "voice";
export const ALERTING_CHANNELS: readonly AlertingChannel[] = ["push", "sms", "voice"];

// Shared with ChannelWorkers so the queue visibility timeout (2x this) and the worker
// Lambda's own `timeout` can never drift apart (E1-S2/S3-INFRA MAJOR: new Lambdas
// otherwise fall back to the 3s AWS default, which a secret fetch + vendor HTTPS call
// routinely exceeds).
export const DEFAULT_WORKER_TIMEOUT_SECONDS = 15;

export interface MessagingAlertingArgs {
  env: string;
  /** Worker Lambda timeout per channel (seconds); queue visibility is set to 2x this. */
  workerTimeoutSeconds?: number;
}

export interface ChannelQueue {
  readonly queue: aws.sqs.Queue;
  readonly dlq: aws.sqs.Queue;
}

/**
 * The alerting messaging plane (E1-S2/S3-INFRA): SNS FIFO topic + one SQS FIFO queue
 * per channel, each with its own DLQ. Shares no construct with the LOB `messaging.ts`
 * (none exists yet). Routing/dedup keys on `channel` only — never `channelTier` or
 * `toneSequence` (boxalarm-docs#12).
 */
export class MessagingAlerting extends pulumi.ComponentResource {
  public readonly topic: aws.sns.Topic;
  public readonly channelQueues: Record<AlertingChannel, ChannelQueue>;

  constructor(name: string, args: MessagingAlertingArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("MessagingAlerting", args.env);
    super("boxalarm:alerting:MessagingAlerting", name, {}, opts);
    const { env } = args;
    const workerTimeoutSeconds = args.workerTimeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS;
    // 2x the worker timeout, not tighter: the backend publisher sets
    // MessageGroupId: dispatchId (fanout/handler.ts, escalation/snsClient.ts), so every
    // member of one dispatch on one channel shares a FIFO group. One member stuck behind
    // a slow/failing vendor call holds up every later member in that group until
    // visibility expires — up to maxReceiveCount(3) x visibilityTimeoutSeconds worst
    // case (~90s at the current 15s worker timeout).
    //
    // Fix considered and deferred: scoping MessageGroupId to `{dispatchId}#{memberId}`
    // would remove the head-of-line block entirely, since nothing in this codebase
    // appears to need cross-member ordering within a dispatch — each delivery receipt is
    // keyed uniquely per {dispatchId, toneSequence, memberId, channel} (CLAUDE.md's
    // exactly-once key), and channel workers already process members independently. That
    // change lives in backend publish code (out of scope for this infra-only PR/branch),
    // so it's tracked as a backend follow-up rather than made here (see #12 — read
    // before touching the alert path).
    //
    // Going *below* 2x here instead, to shrink the blocking window from the infra side,
    // was also considered and rejected: it would narrow the safety margin between the
    // worker's own Lambda timeout and this queue's visibility timeout, risking the same
    // message becoming visible (and re-delivered to a vendor) while the first attempt is
    // still in flight — a duplicate SMS/voice/push send is worse than a slower one.
    const visibilityTimeoutSeconds = workerTimeoutSeconds * 2;

    this.topic = new aws.sns.Topic(
      `${name}-topic`,
      {
        name: `boxalarm-${env}-alerting-topic.fifo`,
        fifoTopic: true,
        // The publisher (fan-out / escalation) sets MessageDeduplicationId explicitly
        // from the {dispatchId}#{toneSequence}#{memberId}#{channel} key — content-based
        // dedup would hash the envelope body instead and silently diverge from it.
        contentBasedDeduplication: false,
      },
      { parent: this },
    );

    this.channelQueues = Object.fromEntries(
      ALERTING_CHANNELS.map((channel) => {
        const dlq = new aws.sqs.Queue(
          `${name}-${channel}-dlq`,
          { name: `boxalarm-${env}-alerting-${channel}-dlq.fifo`, fifoQueue: true },
          { parent: this },
        );

        const queue = new aws.sqs.Queue(
          `${name}-${channel}-queue`,
          {
            name: `boxalarm-${env}-alerting-${channel}-queue.fifo`,
            fifoQueue: true,
            visibilityTimeoutSeconds,
            redrivePolicy: dlq.arn.apply((arn) =>
              JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 3 }),
            ),
          },
          { parent: this },
        );

        new aws.sqs.QueuePolicy(
          `${name}-${channel}-queue-policy`,
          {
            queueUrl: queue.url,
            policy: pulumi.all([queue.arn, this.topic.arn]).apply(([queueArn, topicArn]) =>
              JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "AllowAlertingTopicOnly",
                    Effect: "Allow",
                    Principal: { Service: "sns.amazonaws.com" },
                    Action: "sqs:SendMessage",
                    Resource: queueArn,
                    Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
                  },
                ],
              }),
            ),
          },
          { parent: this },
        );

        new aws.sns.TopicSubscription(
          `${name}-${channel}-subscription`,
          {
            topic: this.topic.arn,
            protocol: "sqs",
            endpoint: queue.arn,
            rawMessageDelivery: true,
            // channel only — never channelTier/toneSequence (boxalarm-docs#12).
            filterPolicy: JSON.stringify({ channel: [channel] }),
          },
          { parent: this },
        );

        return [channel, { queue, dlq }];
      }),
    ) as Record<AlertingChannel, ChannelQueue>;

    this.registerOutputs({ topic: this.topic });
  }
}
