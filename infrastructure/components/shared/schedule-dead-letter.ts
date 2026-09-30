import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface ScheduleDeadLetterArgs {
  /** Physical DLQ name; the depth alarm is `${queueName}-depth`. */
  queueName: string;
  /** The Scheduler execution role that invokes the target; it is granted SendMessage here. */
  schedulerRole: aws.iam.Role;
  alarmActions: pulumi.Input<string>[];
  alarmDescription?: string;
  /** Default true. The canary disables its alarms' actions while it is switched off. */
  actionsEnabled?: boolean;
}

/**
 * Failure handling for an EventBridge Scheduler -> Lambda target (deploy-readiness m2): a
 * DLQ the scheduler role may write, an alarm on its depth, and the `retryPolicy` +
 * `deadLetterConfig` to spread into the schedule's `target`. Without a DLQ a scheduler-side
 * invoke failure (throttle, deleted function, denied role) is retried and then dropped with
 * no trace; the target's own Errors alarm never sees it.
 */
export class ScheduleDeadLetter extends pulumi.ComponentResource {
  public readonly dlq: aws.sqs.Queue;
  public readonly depthAlarm: aws.cloudwatch.MetricAlarm;
  public readonly targetConfig: {
    retryPolicy: { maximumRetryAttempts: number; maximumEventAgeInSeconds: number };
    deadLetterConfig: { arn: pulumi.Output<string> };
  };

  constructor(name: string, args: ScheduleDeadLetterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("boxalarm:shared:ScheduleDeadLetter", name, {}, opts);

    this.dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      { name: args.queueName, messageRetentionSeconds: 1_209_600 },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-dlq-send-policy`,
      {
        role: args.schedulerRole.id,
        policy: this.dlq.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "SchedulerDeadLetter",
                Effect: "Allow",
                Action: "sqs:SendMessage",
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.depthAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-depth-alarm`,
      {
        name: `${args.queueName}-depth`,
        alarmDescription:
          args.alarmDescription ??
          "EventBridge Scheduler could not invoke this schedule's target after its retries; the run " +
            "never happened. Check the message's error attributes, fix, and invoke by hand if needed.",
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.dlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        actionsEnabled: args.actionsEnabled ?? true,
        alarmActions: args.alarmActions,
      },
      { parent: this },
    );

    this.targetConfig = {
      retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
      deadLetterConfig: { arn: this.dlq.arn },
    };

    this.registerOutputs({ dlq: this.dlq });
  }
}
