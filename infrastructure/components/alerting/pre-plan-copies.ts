import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { RuleDeliveryGuard } from "../messaging/rule-delivery";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";

/** Enrichment consumers are not on the page path: a small, fixed share of account concurrency. */
export const PRE_PLAN_COPY_RESERVED_CONCURRENCY = 2;
export const PRE_PLAN_COPY_TIMEOUT_SECONDS = 15;

export interface PrePlanCopiesArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  /** alerting-page topic (alarms.ts): a DLQ'd copy event pages like every alerting DLQ. */
  pageTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

interface CopyConsumerSpec {
  /** Short key used in logical and physical names, e.g. "preplan-copy". */
  readonly key: string;
  readonly detailType: string;
  /** backend/scripts/lambda-manifest.mjs function key. */
  readonly manifestFunction: string;
  /** Base-table partition keys the consumer's TransactWriteItems touches (the copy + its EVT# dedup). */
  readonly leadingKeys: readonly string[];
}

export interface CopyConsumer {
  readonly lambda: ServiceLambda;
  readonly queue: aws.sqs.Queue;
  readonly dlq: aws.sqs.Queue;
  readonly rule: aws.cloudwatch.EventRule;
  readonly eventSource: aws.lambda.EventSourceMapping;
  readonly dlqAlarm: aws.cloudwatch.MetricAlarm;
}

const SPECS = {
  prePlan: {
    key: "preplan-copy",
    detailType: "inspections.preplan.updated",
    manifestFunction: "preplan-copy-consumer",
    leadingKeys: ["DEPT#*#PREPLAN", "DEPT#*#DEDUP#preplan-copy-consumer#*"],
  },
  hydrant: {
    key: "hydrant-copy",
    detailType: "inspections.hydrant.updated",
    manifestFunction: "hydrant-copy-consumer",
    leadingKeys: ["DEPT#*#HYDRANT", "DEPT#*#DEDUP#hydrant-copy-consumer#*"],
  },
} as const satisfies Record<string, CopyConsumerSpec>;

/**
 * Pre-plan / hydrant context for the dispatch detail (E5-S4/E5-S8): two alerting-owned
 * consumers that project inspections events off the platform bus into the alerting table as
 * PRE_PLAN_COPY / HYDRANT_COPY, so the detail route can show them without the alerting plane
 * ever reading a LOB table. Each is rule (source + detail-type) -> SQS + DLQ -> Lambda, under
 * the alerting permissions boundary, writing only its own partitions of the alerting table.
 *
 * Nothing here is on the page path: fan-out never reads these copies, and a dead consumer
 * only means an alert shows no (or stale) pre-plan — which is why the DLQ still pages.
 */
/** Backend namespace of the pre-plan matcher's metrics (prePlan/locality.ts). */
export const PRE_PLAN_METRIC_NAMESPACE = "Boxalarm/alerting-pre-plan";

export class PrePlanCopies extends pulumi.ComponentResource {
  public readonly prePlan: CopyConsumer;
  public readonly hydrant: CopyConsumer;
  /** The home-locality config is unusable (item or stack default present but not parseable). */
  public readonly homeLocalityInvalidAlarm: aws.cloudwatch.MetricAlarm;
  /** A dispatch detail was served with no home locality: every pre-plan on it is flagged. */
  public readonly homeLocalityMissingAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: PrePlanCopiesArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PrePlanCopies", args.env);
    super("boxalarm:alerting:PrePlanCopies", name, {}, opts);

    this.prePlan = this.consumer(name, args, SPECS.prePlan);
    this.hydrant = this.consumer(name, args, SPECS.hydrant);

    grantAlertingCmk(
      name,
      { prePlanCopy: this.prePlan.lambda.role, hydrantCopy: this.hydrant.lambda.role },
      args.alertingCmkArn,
      { parent: this },
    );

    // Round-4 m7: the home-locality config is what lets a pre-plan be shown unflagged. When it
    // is broken or missing nothing pages late, but every alert's pre-plan says VERIFY ADDRESS,
    // so it alarms through the same alerting-page topic as the copy DLQs above. Only the
    // dispatch-detail count is alarmed; a manual-entry form load is counted separately
    // (HomeLocalityFormMissing) and never alarms.
    const localityAlarm = (key: string, metricName: string, description: string) =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${key}-alarm`,
        {
          name: `boxalarm-${args.env}-alerting-${key}`,
          alarmDescription: description,
          namespace: PRE_PLAN_METRIC_NAMESPACE,
          metricName,
          statistic: "Sum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 300,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [args.pageTopicArn],
        },
        { parent: this },
      );
    this.homeLocalityInvalidAlarm = localityAlarm(
      "home-locality-invalid",
      "HomeLocalityInvalid",
      "The department HOME_LOCALITY item or the ALERTING_HOME_LOCALITY stack default is present " +
        "but unusable; pre-plans fall back to the next source or are all flagged. See " +
        "docs/runbooks/alert-context-replay.md, Home locality.",
    );
    this.homeLocalityMissingAlarm = localityAlarm(
      "home-locality-missing",
      "HomeLocalityMissing",
      "A dispatch detail was served with no home locality, so every pre-plan match is flagged " +
        "VERIFY ADDRESS. See docs/runbooks/alert-context-replay.md, Home locality.",
    );

    this.registerOutputs({
      prePlanConsumer: this.prePlan.lambda,
      hydrantConsumer: this.hydrant.lambda,
    });
  }

  private consumer(name: string, args: PrePlanCopiesArgs, spec: CopyConsumerSpec): CopyConsumer {
    const { env } = args;
    const prefix = `${name}-${spec.key}`;

    const dlq = new aws.sqs.Queue(
      `${prefix}-dlq`,
      { name: `boxalarm-${env}-alerting-${spec.key}-dlq`, messageRetentionSeconds: 1_209_600 },
      { parent: this },
    );
    const queue = new aws.sqs.Queue(
      `${prefix}-queue`,
      {
        name: `boxalarm-${env}-alerting-${spec.key}-queue`,
        // 6x the function timeout (AWS guidance for an SQS event source).
        visibilityTimeoutSeconds: PRE_PLAN_COPY_TIMEOUT_SECONDS * 6,
        redrivePolicy: dlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
        ),
      },
      { parent: this },
    );

    // Match the producer as well as the detail-type: every writer of these events stamps
    // `inspections-service`, and without it any producer on the platform bus could inject
    // pre-plan or hydrant content into what a responding crew reads.
    const rule = new aws.cloudwatch.EventRule(
      `${prefix}-rule`,
      {
        name: `boxalarm-${env}-alerting-${spec.key}`,
        eventBusName: args.busName,
        eventPattern: JSON.stringify({
          source: ["inspections-service"],
          "detail-type": [spec.detailType],
        }),
      },
      { parent: this },
    );

    new aws.sqs.QueuePolicy(
      `${prefix}-queue-policy`,
      {
        queueUrl: queue.url,
        policy: pulumi.all([queue.arn, rule.arn]).apply(([queueArn, ruleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowCopyRuleOnly",
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

    // No input transformer: the consumer parses the whole EventBridge event, envelope under
    // `detail` (prePlanCopyHandler/hydrantCopyHandler parseEnvelope).
    const deliveryGuard = new RuleDeliveryGuard(
      `${prefix}-delivery`,
      {
        alarmName: `boxalarm-${env}-alerting-${spec.key}-failed-invocations`,
        rule,
        busName: args.busName,
        deadLetterQueue: dlq,
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );
    new aws.cloudwatch.EventTarget(
      `${prefix}-target`,
      {
        rule: rule.name,
        eventBusName: args.busName,
        arn: queue.arn,
        deadLetterConfig: { arn: dlq.arn },
      },
      { parent: this, dependsOn: [deliveryGuard] },
    );

    const lambda = new ServiceLambda(
      `${prefix}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-${spec.manifestFunction}`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", spec.manifestFunction),
        logGroup: args.logGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        timeout: PRE_PLAN_COPY_TIMEOUT_SECONDS,
        additionalPolicyStatements: [
          {
            // One TransactWriteItems per event: a Put (EVT# dedup marker) and an Update (the
            // copy). DynamoDB authorizes each item as its own action; the leading-key
            // condition confines both to this consumer's partitions of the alerting table.
            Sid: "AlertingCopyWrite",
            Effect: "Allow",
            Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: args.alertingTableArn as string,
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...spec.leadingKeys] },
            },
          },
        ],
        reservedConcurrentExecutions: PRE_PLAN_COPY_RESERVED_CONCURRENCY,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const eventSource = new aws.lambda.EventSourceMapping(
      `${prefix}-event-source`,
      {
        eventSourceArn: queue.arn,
        functionName: lambda.function.name,
        batchSize: 10,
        // The handlers return batchItemFailures: a poison message is retried (and DLQ'd)
        // alone instead of dragging its nine batch-mates to the DLQ with it.
        functionResponseTypes: ["ReportBatchItemFailures"],
        // Pinned to reserved concurrency: throttled receives count toward maxReceiveCount.
        scalingConfig: { maximumConcurrency: PRE_PLAN_COPY_RESERVED_CONCURRENCY },
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${prefix}-consume-policy`,
      {
        role: lambda.role.id,
        policy: queue.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ConsumeCopyQueue",
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

    // A dead-lettered copy event means an alert keeps showing a stale (or no) pre-plan or
    // hydrant list — page through the alerting-page topic like every alerting DLQ.
    const dlqAlarm = new aws.cloudwatch.MetricAlarm(
      `${prefix}-dlq-alarm`,
      {
        name: `boxalarm-${env}-alerting-${spec.key}-dlq-not-empty`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: dlq.name },
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

    return { lambda, queue, dlq, rule, eventSource, dlqAlarm };
  }
}
