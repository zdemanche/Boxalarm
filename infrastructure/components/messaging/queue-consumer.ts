import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { RuleDeliveryGuard, ruleSendPolicy } from "./rule-delivery";

export interface QueueConsumerArgs {
  env: string;
  busName: pulumi.Input<string>;
  ruleName: string;
  eventPattern: string;
  queueName: string;
  lambda: aws.lambda.Function;
  lambdaRole: aws.iam.Role;
  maxReceiveCount?: number;
  batchSize?: number;
  /**
   * Caps how many concurrent Lambda executions this queue's event source mapping can
   * drive. Left unset, SQS event source mappings have no concurrency ceiling of their
   * own — a burst on this queue can consume account-level concurrency that
   * alerting-service's Lambdas share from the same pool (alerting-service is not
   * VPC-attached and has no reserved concurrency of its own to insulate it). Defaults
   * to a small cap suited to LOB-plane traffic volumes; override for a consumer that
   * legitimately needs more.
   */
  maximumConcurrency?: number;
  /**
   * Opt in only for a handler that returns an SQSBatchResponse (`batchItemFailures`).
   * With it set, a handler that returns nothing (or throws for the batch) is treated
   * as all-succeeded / all-failed respectively, so leave it off for handlers that
   * still signal failure by throwing — they'd otherwise have their failures deleted.
   */
  reportBatchItemFailures?: boolean;
  /**
   * The main queue's visibility timeout. Leave unset for the SQS default (30 s); a consumer
   * whose Lambda timeout is longer must set at least 6x that timeout (AWS guidance).
   */
  visibilityTimeoutSeconds?: number;
}

/**
 * Reusable "Lambda consumes an EventBridge rule via SQS" wiring: DLQ, main
 * queue with redrive, an EventBridge rule + target on the given bus (the target
 * dead-letters into the same DLQ, with a FailedInvocations alarm), an SQS
 * event source mapping, and the IAM the consumer Lambda needs to drain it.
 */
export class QueueConsumer extends pulumi.ComponentResource {
  public readonly queue: aws.sqs.Queue;
  public readonly dlq: aws.sqs.Queue;
  public readonly rule: aws.cloudwatch.EventRule;
  public readonly target: aws.cloudwatch.EventTarget;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly dlqDepthAlarm: aws.cloudwatch.MetricAlarm;
  public readonly deliveryGuard: RuleDeliveryGuard;

  constructor(name: string, args: QueueConsumerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("boxalarm:messaging:QueueConsumer", name, {}, opts);
    const maxReceiveCount = args.maxReceiveCount ?? 5;

    this.dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      { name: `${args.queueName}-dlq` },
      { parent: this },
    );

    this.queue = new aws.sqs.Queue(
      `${name}-queue`,
      {
        name: args.queueName,
        ...(args.visibilityTimeoutSeconds !== undefined
          ? { visibilityTimeoutSeconds: args.visibilityTimeoutSeconds }
          : {}),
        redrivePolicy: this.dlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount }),
        ),
      },
      { parent: this },
    );

    this.rule = new aws.cloudwatch.EventRule(
      `${name}-rule`,
      { name: args.ruleName, eventBusName: args.busName, eventPattern: args.eventPattern },
      { parent: this },
    );

    // aws:SourceArn is the RULE ARN for an EventBridge -> SQS delivery, never the bus ARN.
    // Conditioning on the bus ARN denied every delivery through this component, silently
    // (deploy-readiness C1).
    const queuePolicy = new aws.sqs.QueuePolicy(
      `${name}-queue-policy`,
      {
        queueUrl: this.queue.id,
        policy: ruleSendPolicy(this.queue.arn, this.rule.arn, "AllowEventBridgeSend"),
      },
      { parent: this },
    );

    // An event the rule cannot deliver goes to the same DLQ as a message the consumer could
    // not process, so the one DLQ alarm covers both; FailedInvocations pages even if the DLQ
    // write itself is refused.
    this.deliveryGuard = new RuleDeliveryGuard(
      `${name}-delivery`,
      {
        alarmName: `${args.ruleName}-failed-invocations`,
        rule: this.rule,
        busName: args.busName,
        deadLetterQueue: this.dlq,
      },
      { parent: this },
    );

    this.target = new aws.cloudwatch.EventTarget(
      `${name}-target`,
      {
        rule: this.rule.name,
        eventBusName: args.busName,
        arn: this.queue.arn,
        deadLetterConfig: { arn: this.dlq.arn },
      },
      { parent: this, dependsOn: [queuePolicy, this.deliveryGuard] },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-esm`,
      {
        eventSourceArn: this.queue.arn,
        functionName: args.lambda.name,
        batchSize: args.batchSize ?? 10,
        scalingConfig: { maximumConcurrency: args.maximumConcurrency ?? 5 },
        ...(args.reportBatchItemFailures
          ? { functionResponseTypes: ["ReportBatchItemFailures"] }
          : {}),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-consume-policy`,
      {
        role: args.lambdaRole.id,
        policy: this.queue.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ConsumeQueue",
                Effect: "Allow",
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.dlqDepthAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-dlq-depth-alarm`,
      {
        name: `${args.queueName}-dlq-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.dlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.registerOutputs({ queue: this.queue, dlq: this.dlq, rule: this.rule });
  }
}
