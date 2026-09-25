import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export type AlertingChannel = "push" | "sms" | "voice";
export const ALERTING_CHANNELS: readonly AlertingChannel[] = ["push", "sms", "voice"];

/**
 * Channel-worker Lambda timeout (seconds): a secret fetch plus one vendor HTTPS call.
 * Shared by MessagingAlerting (queue visibility = 2x this) and ChannelWorkers (the
 * Lambda's own timeout) so the two cannot drift apart.
 */
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
