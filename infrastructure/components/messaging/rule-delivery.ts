import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

/**
 * SQS resource policy letting exactly one EventBridge rule send to `queueArn`.
 *
 * For an SQS target EventBridge presents the RULE ARN
 * (`arn:aws:events:<region>:<acct>:rule/<bus>/<rule>`) as `aws:SourceArn`, never the bus
 * ARN. Conditioning on the bus ARN denies every delivery, and the only trace is the rule's
 * `FailedInvocations` metric (post-merge deploy-readiness C1).
 */
export function ruleSendPolicy(
  queueArn: pulumi.Input<string>,
  ruleArn: pulumi.Input<string>,
  sid: string,
): pulumi.Output<string> {
  return pulumi.all([queueArn, ruleArn]).apply(([queue, rule]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: sid,
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: "sqs:SendMessage",
          Resource: queue,
          Condition: { ArnEquals: { "aws:SourceArn": rule } },
        },
      ],
    }),
  );
}

export interface RuleDeliveryGuardArgs {
  /**
   * Physical name of the FailedInvocations alarm, ending `-failed-invocations`. The
   * InvocationsFailedToBeSentToDlq alarm takes the same stem with `-dlq-send-failed`.
   */
  alarmName: string;
  rule: aws.cloudwatch.EventRule;
  /** The custom bus the rule is on; omit for a default-bus rule (no EventBusName dimension). */
  busName?: pulumi.Input<string>;
  /**
   * The target's dead-letter queue. It receives a resource policy letting only `rule` send,
   * so an event EventBridge could not deliver lands somewhere alarmed instead of vanishing
   * after 24 h of retries. Pass a queue that has no other QueuePolicy (one policy per queue).
   */
  deadLetterQueue: aws.sqs.Queue;
  alarmActions: pulumi.Input<string>[];
}

/**
 * What every EventBridge rule target needs so a delivery failure is never silent
 * (deploy-readiness C1/m1): a DLQ policy the rule can write through, and two alarms with
 * actions. Wire the queue itself into the target as `deadLetterConfig: { arn: deadLetterQueue.arn }`.
 *
 * How the three signals divide (AWS/Events metric semantics):
 * - An event that exhausted its retries and WAS dead-lettered shows only in the DLQ, and the
 *   DLQ's own depth alarm fires; redrive it.
 * - `FailedInvocations` counts invocations that failed permanently and were NOT sent to the
 *   DLQ, so when it fires the event is most likely lost - there is nothing to redrive; the
 *   producer must re-emit it.
 * - `InvocationsFailedToBeSentToDlq` counts events whose dead-lettering itself failed (e.g. a
 *   DLQ policy that does not name the rule): also lost.
 */
export class RuleDeliveryGuard extends pulumi.ComponentResource {
  public readonly deadLetterPolicy: aws.sqs.QueuePolicy;
  public readonly failedInvocationsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly dlqSendFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: RuleDeliveryGuardArgs, opts?: pulumi.ComponentResourceOptions) {
    super("boxalarm:messaging:RuleDeliveryGuard", name, {}, opts);

    this.deadLetterPolicy = new aws.sqs.QueuePolicy(
      `${name}-dead-letter-policy`,
      {
        queueUrl: args.deadLetterQueue.id,
        policy: ruleSendPolicy(args.deadLetterQueue.arn, args.rule.arn, "AllowRuleDeadLetter"),
      },
      { parent: this },
    );

    const dimensions: Record<string, pulumi.Input<string>> = args.busName !== undefined
      ? { RuleName: args.rule.name, EventBusName: args.busName }
      : { RuleName: args.rule.name };
    const lostEventAlarm = (
      key: string,
      alarmName: string,
      metricName: string,
      description: string,
    ) =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${key}-alarm`,
        {
          name: alarmName,
          alarmDescription: description,
          namespace: "AWS/Events",
          metricName,
          dimensions,
          statistic: "Sum",
          period: 60,
          evaluationPeriods: 1,
          threshold: 0,
          comparisonOperator: "GreaterThanThreshold",
          treatMissingData: "notBreaching",
          alarmActions: args.alarmActions,
        },
        { parent: this },
      );

    this.failedInvocationsAlarm = lostEventAlarm(
      "failed-invocations",
      args.alarmName,
      "FailedInvocations",
      "EventBridge failed to deliver an event from this rule to its target and did NOT " +
        "dead-letter it (a denied queue policy, a deleted target, a permanent error), so the event " +
        "is most likely lost - there is nothing in the DLQ to redrive. Check the target's resource " +
        "policy against the rule ARN, fix, then have the producer re-emit the event (for member " +
        "state, docs/runbooks/eligibility-snapshot-repair.md). Dead-lettered events page through " +
        "the DLQ depth alarm instead.",
    );
    this.dlqSendFailedAlarm = lostEventAlarm(
      "dlq-send-failed",
      `${args.alarmName.replace(/-failed-invocations$/, "")}-dlq-send-failed`,
      "InvocationsFailedToBeSentToDlq",
      "EventBridge could not deliver an event from this rule AND could not write it to the " +
        "target's dead-letter queue (usually the DLQ policy does not name this rule, or the DLQ " +
        "was deleted). The event is lost. Fix the DLQ policy, then have the producer re-emit it.",
    );

    this.registerOutputs({ failedInvocationsAlarm: this.failedInvocationsAlarm });
  }
}
