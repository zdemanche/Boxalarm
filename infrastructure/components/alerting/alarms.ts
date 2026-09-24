import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";
import { ALERTING_CHANNELS, AlertingChannel, ChannelQueue } from "./messaging-alerting";

const NON_PROD_ENVS = new Set(["dev", "qa", "staging"]);

export interface AlertingAlarmsArgs {
  env: string;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
}

/**
 * Alerting-plane paging (E1-S11-INFRA): a dedicated standard SNS topic
 * (`alerting-page`, distinct from the FIFO delivery topic) that every alerting alarm
 * pages through, a DLQ-non-empty alarm per channel, and a per-channel fault-injection
 * SSM switch present in dev/qa/staging only (never prod).
 */
export class AlertingAlarms extends pulumi.ComponentResource {
  public readonly pageTopic: aws.sns.Topic;
  public readonly faultInjectionParameters: Partial<Record<AlertingChannel, aws.ssm.Parameter>>;

  constructor(name: string, args: AlertingAlarmsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingAlarms", args.env);
    super("boxalarm:alerting:AlertingAlarms", name, {}, opts);
    const { env } = args;

    this.pageTopic = new aws.sns.Topic(
      `${name}-page-topic`,
      { name: `boxalarm-${env}-alerting-page` },
      { parent: this },
    );

    for (const channel of ALERTING_CHANNELS) {
      const dlq = args.channelQueues[channel].dlq;

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-dlq-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-dlq-not-empty`,
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensions: { QueueName: dlq.name },
          statistic: "Maximum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-delivery-failure-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-delivery-failure-rate`,
          namespace: `Boxalarm/AlertingChannel`,
          metricName: "SendFailed",
          dimensions: { channel },
          statistic: "Sum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );
    }

    this.faultInjectionParameters = NON_PROD_ENVS.has(env)
      ? Object.fromEntries(
          ALERTING_CHANNELS.map((channel) => [
            channel,
            new aws.ssm.Parameter(
              `${name}-${channel}-fault-injection`,
              {
                name: `/boxalarm/${env}/alerting/${channel}/fault-injection`,
                type: "String",
                value: "off",
                description: `Non-prod fault-injection switch for the ${channel} worker`,
              },
              { parent: this },
            ),
          ]),
        )
      : {};

    this.registerOutputs({ pageTopic: this.pageTopic });
  }
}
