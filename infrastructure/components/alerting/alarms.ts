import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";
import { ALERTING_CHANNELS, AlertingChannel, ChannelQueue } from "./messaging-alerting";

const NON_PROD_ENVS = new Set(["dev", "qa", "staging"]);

export interface AlertingAlarmsArgs {
  env: string;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  fanOutFunctionName: pulumi.Input<string>;
  escalationFunctionName: pulumi.Input<string>;
  memberUpdatedDlq: aws.sqs.Queue;
  /**
   * Email address subscribed to `alerting-page` (`boxalarm-infra:alertingPageEmail`
   * stack config, optional). Real on-call routing (a paging vendor, an escalation
   * policy, PagerDuty/Opsgenie, etc.) may end up provisioned elsewhere entirely — this
   * is a documented placeholder so the topic is never silently unsubscribed, not a
   * claim that email is the final on-call mechanism. If unset, a synth-time warning is
   * emitted: every alarm below still fires, but nobody is paged.
   */
  pageEmail?: string;
}

/**
 * Alerting-plane paging (E1-S11-INFRA): a dedicated standard SNS topic
 * (`alerting-page`, distinct from the FIFO delivery topic) that every alerting alarm
 * pages through, alarms on every alert-path failure mode this batch introduces, and a
 * per-channel fault-injection SSM switch present in dev/qa/staging only (never prod).
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

    if (args.pageEmail) {
      new aws.sns.TopicSubscription(
        `${name}-page-email-subscription`,
        { topic: this.pageTopic.arn, protocol: "email", endpoint: args.pageEmail },
        { parent: this },
      );
    } else {
      pulumi.log.warn(
        `AlertingAlarms(${name}): no pageEmail configured (boxalarm-infra:alertingPageEmail) — ` +
          `boxalarm-${env}-alerting-page has zero subscriptions and every alarm below fires into ` +
          `the void. Set the config value, or confirm real on-call routing is provisioned ` +
          `elsewhere before deploying to a real environment.`,
      );
    }

    for (const channel of ALERTING_CHANNELS) {
      const queue = args.channelQueues[channel].queue;
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

      // Catches a worker that is consuming but stuck (e.g. a hung vendor call) even
      // though nothing has hit the DLQ yet. maxReceiveCount 3 at the queue's visibility
      // timeout means a healthy queue never holds a message this long.
      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-oldest-message-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-oldest-message-age`,
          namespace: "AWS/SQS",
          metricName: "ApproximateAgeOfOldestMessage",
          dimensions: { QueueName: queue.name },
          statistic: "Maximum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 120,
          period: 60,
          evaluationPeriods: 2,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );
    }

    // Fan-out: an unconsumed or stuck DynamoDB stream shows up as rising IteratorAge
    // (nobody paged despite CRITICAL fix #1's ReportBatchItemFailures) or as Errors.
    new aws.cloudwatch.MetricAlarm(
      `${name}-fan-out-errors-alarm`,
      {
        name: `boxalarm-${env}-alerting-fan-out-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: args.fanOutFunctionName },
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

    new aws.cloudwatch.MetricAlarm(
      `${name}-fan-out-iterator-age-alarm`,
      {
        name: `boxalarm-${env}-alerting-fan-out-iterator-age`,
        namespace: "AWS/Lambda",
        metricName: "IteratorAge",
        dimensions: { FunctionName: args.fanOutFunctionName },
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        // 5 minutes: a DISPATCH_ALERT sitting unprocessed this long is already a
        // life-safety-relevant delay.
        threshold: 300000,
        period: 60,
        evaluationPeriods: 2,
        treatMissingData: "notBreaching",
        alarmActions: [this.pageTopic.arn],
      },
      { parent: this },
    );

    // Escalation: the Scheduler invokes this async with no onFailure destination, so an
    // escalation that throws is retried twice and then dropped with no other record.
    new aws.cloudwatch.MetricAlarm(
      `${name}-escalation-errors-alarm`,
      {
        name: `boxalarm-${env}-alerting-escalation-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: args.escalationFunctionName },
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

    new aws.cloudwatch.MetricAlarm(
      `${name}-escalation-throttles-alarm`,
      {
        name: `boxalarm-${env}-alerting-escalation-throttles`,
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        dimensions: { FunctionName: args.escalationFunctionName },
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

    // Member-updated DLQ: a lost personnel.member.updated event means a member silently
    // stops getting push with no other signal.
    new aws.cloudwatch.MetricAlarm(
      `${name}-member-updated-dlq-alarm`,
      {
        name: `boxalarm-${env}-alerting-member-updated-dlq-not-empty`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: args.memberUpdatedDlq.name },
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
