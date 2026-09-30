import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { RuleDeliveryGuard } from "../messaging/rule-delivery";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";

const RESERVED_CONCURRENCY = 1;
const TIMEOUT_SECONDS = 15;

export interface AlertRulesCopyArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  /** alerting-page topic (alarms.ts): a DLQ'd rules event means the ladder runs on stale rules. */
  pageTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Design review M1: the department's ALERT_RULES reach the alerting plane only as the
 * alerting-owned ALERT_RULES_COPY. Rule (platform-service, platform.config.updated,
 * configType ALERT_RULES) -> SQS + DLQ -> alertRules/alertRulesCopyHandler.ts, under the
 * alerting permissions boundary, writing only the DEPT#*#ALERT_RULES partition. The alerting
 * plane still holds no permission on the platform table.
 */
export class AlertRulesCopy extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly queue: aws.sqs.Queue;
  public readonly dlq: aws.sqs.Queue;
  public readonly rule: aws.cloudwatch.EventRule;
  public readonly dlqAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: AlertRulesCopyArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertRulesCopy", args.env);
    super("boxalarm:alerting:AlertRulesCopy", name, {}, opts);
    const { env } = args;

    this.dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      { name: `boxalarm-${env}-alerting-alert-rules-copy-dlq`, messageRetentionSeconds: 1_209_600 },
      { parent: this },
    );
    this.queue = new aws.sqs.Queue(
      `${name}-queue`,
      {
        name: `boxalarm-${env}-alerting-alert-rules-copy-queue`,
        visibilityTimeoutSeconds: TIMEOUT_SECONDS * 6,
        redrivePolicy: this.dlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
        ),
      },
      { parent: this },
    );

    // Matches the declared producer (platform-service) and the config type. This is a routing
    // filter, not a trust boundary: `source` is whatever the publisher declares - the platform
    // outbox publisher copies each row's own `source`, and no events:PutEvents grant on the bus
    // carries an events:source condition - so it keeps a same-named event from another producer out
    // by accident, not by force (review F3).
    this.rule = new aws.cloudwatch.EventRule(
      `${name}-rule`,
      {
        name: `boxalarm-${env}-alerting-alert-rules-copy`,
        eventBusName: args.busName,
        eventPattern: JSON.stringify({
          source: ["platform-service"],
          "detail-type": ["platform.config.updated"],
          detail: { payload: { configType: ["ALERT_RULES"] } },
        }),
      },
      { parent: this },
    );

    const queuePolicy = new aws.sqs.QueuePolicy(
      `${name}-queue-policy`,
      {
        queueUrl: this.queue.url,
        policy: pulumi.all([this.queue.arn, this.rule.arn]).apply(([queueArn, ruleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowAlertRulesRuleOnly",
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: { ArnEquals: { "aws:SourceArn": ruleArn } },
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    // A rules event EventBridge cannot deliver dead-letters into the alarmed DLQ, and pages.
    const deliveryGuard = new RuleDeliveryGuard(
      `${name}-delivery`,
      {
        alarmName: `boxalarm-${env}-alerting-alert-rules-copy-failed-invocations`,
        rule: this.rule,
        busName: args.busName,
        deadLetterQueue: this.dlq,
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    new aws.cloudwatch.EventTarget(
      `${name}-target`,
      {
        rule: this.rule.name,
        eventBusName: args.busName,
        arn: this.queue.arn,
        deadLetterConfig: { arn: this.dlq.arn },
      },
      // The main queue policy must exist before the target, or a first-deploy delivery is denied.
      { parent: this, dependsOn: [queuePolicy, deliveryGuard] },
    );

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-alert-rules-copy-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "alert-rules-copy-consumer"),
        logGroup: args.logGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        timeout: TIMEOUT_SECONDS,
        additionalPolicyStatements: [
          {
            Sid: "AlertRulesCopyWrite",
            Effect: "Allow",
            Action: ["dynamodb:PutItem"],
            Resource: args.alertingTableArn as string,
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#ALERT_RULES"] },
            },
          },
        ],
        reservedConcurrentExecutions: RESERVED_CONCURRENCY,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.lambda.EventSourceMapping(
      `${name}-event-source`,
      {
        eventSourceArn: this.queue.arn,
        functionName: this.lambda.function.name,
        batchSize: 10,
        functionResponseTypes: ["ReportBatchItemFailures"],
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-consume-policy`,
      {
        role: this.lambda.role.id,
        policy: this.queue.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ConsumeAlertRulesQueue",
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

    this.dlqAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-dlq-alarm`,
      {
        name: `boxalarm-${env}-alerting-alert-rules-copy-dlq-not-empty`,
        alarmDescription:
          "A department ALERT_RULES change could not be copied into the alerting table; the tone ladder is running on the previous rules (or the defaults). Check the alert-rules-copy consumer logs, fix, then redrive the DLQ.",
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.dlq.name },
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    grantAlertingCmk(name, { alertRulesCopy: this.lambda.role }, args.alertingCmkArn, {
      parent: this,
    });

    this.registerOutputs({ lambda: this.lambda });
  }
}
