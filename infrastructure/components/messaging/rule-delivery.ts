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
  /** Physical name of the FailedInvocations alarm. */
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
  alarmDescription?: string;
}

/**
 * The two things every EventBridge rule target needs so a delivery failure is never silent
 * (deploy-readiness C1/m1): a DLQ policy the rule can write through, and a
 * `FailedInvocations > 0` alarm with an action. Wire the queue itself into the target as
 * `deadLetterConfig: { arn: deadLetterQueue.arn }`.
 */
export class RuleDeliveryGuard extends pulumi.ComponentResource {
  public readonly deadLetterPolicy: aws.sqs.QueuePolicy;
  public readonly failedInvocationsAlarm: aws.cloudwatch.MetricAlarm;

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

    this.failedInvocationsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-failed-invocations-alarm`,
      {
        name: args.alarmName,
        alarmDescription:
          args.alarmDescription ??
          "EventBridge could not deliver an event from this rule to its target (a denied queue " +
            "policy, a deleted target, or throttling). The event goes to the target DLQ; check the " +
            "target's resource policy against the rule ARN, fix, then redrive the DLQ.",
        namespace: "AWS/Events",
        metricName: "FailedInvocations",
        dimensions:
          args.busName !== undefined
            ? { RuleName: args.rule.name, EventBusName: args.busName }
            : { RuleName: args.rule.name },
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

    this.registerOutputs({ failedInvocationsAlarm: this.failedInvocationsAlarm });
  }
}
