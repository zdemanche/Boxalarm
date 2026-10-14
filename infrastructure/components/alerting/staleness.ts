import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { ScheduleDeadLetter } from "../shared/schedule-dead-letter";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";

export interface EligibilityStalenessArgs {
  env: string;
  deptId: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  pageTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
  /** The queues feeding the eligibility snapshot; each pages when its oldest message ages. */
  eligibilityFeedQueueNames: Record<EligibilityFeedQueue, pulumi.Input<string>>;
}

export type EligibilityFeedQueue =
  "member-updated" | "availability-snapshot" | "eligibility-changed";

export const FEED_QUEUE_AGE_THRESHOLD_SECONDS = 180;

/**
 * Eligibility-snapshot staleness (E1-S13-INFRA): a recurring 5-minute schedule per department
 * invoking `eligibility/staleness/checkHandler.handler`, which emits `SnapshotStale` under
 * `Boxalarm/AlertingEligibility`.
 *
 * `SnapshotStale` is dashboard-only: a quiet department legitimately has no eligibility write
 * for 15+ minutes, so alarming on it paged on-call for nothing. Paging is on the age of the
 * oldest message in each queue that feeds the snapshot (member-updated, availability-snapshot,
 * eligibility-changed): a stuck or throttled consumer shows as a message that stays unread,
 * and an empty queue reads as 0.
 */
export class EligibilityStaleness extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly schedule: aws.scheduler.Schedule;
  public readonly alarm: aws.cloudwatch.MetricAlarm;
  public readonly feedQueueAgeAlarms: aws.cloudwatch.MetricAlarm[];
  public readonly errorsAlarm: aws.cloudwatch.MetricAlarm;

  constructor(
    name: string,
    args: EligibilityStalenessArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("EligibilityStaleness", args.env);
    super("boxalarm:alerting:EligibilityStaleness", name, {}, opts);
    const { env, deptId } = args;

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-eligibility-staleness-check`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "eligibility-staleness-check"),
        logGroup: args.logGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName, DEPT_ID: deptId },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableRead",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
        ],
        reservedConcurrentExecutions: 2,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-alerting-staleness-scheduler`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        // Same alerting-plane boundary as the canary and escalation scheduler roles.
        permissionsBoundary: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-scheduler-role-policy`,
      {
        role: schedulerRole.id,
        policy: this.lambda.function.arn.apply((fnArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeStalenessCheckOnly",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: fnArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    const deadLetter = new ScheduleDeadLetter(
      `${name}-schedule-dead-letter`,
      {
        queueName: `boxalarm-${env}-alerting-eligibility-staleness-scheduler-dlq`,
        schedulerRole,
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    this.schedule = new aws.scheduler.Schedule(
      `${name}-schedule`,
      {
        name: `boxalarm-${env}-alerting-${deptId}-eligibility-staleness`,
        scheduleExpression: "rate(5 minutes)",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.lambda.function.arn,
          roleArn: schedulerRole.arn,
          ...deadLetter.targetConfig,
        },
      },
      { parent: this },
    );

    this.alarm = new aws.cloudwatch.MetricAlarm(
      `${name}-alarm`,
      {
        name: `boxalarm-${env}-alerting-eligibility-snapshot-stale`,
        namespace: "Boxalarm/AlertingEligibility",
        metricName: "SnapshotStale",
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 300,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.feedQueueAgeAlarms = (
      Object.entries(args.eligibilityFeedQueueNames) as [
        EligibilityFeedQueue,
        pulumi.Input<string>,
      ][]
    ).map(
      ([feed, queueName]) =>
        new aws.cloudwatch.MetricAlarm(
          `${name}-${feed}-queue-age-alarm`,
          {
            name: `boxalarm-${env}-alerting-eligibility-${feed}-queue-age`,
            alarmDescription:
              `The oldest message in the ${feed} queue has waited over ${FEED_QUEUE_AGE_THRESHOLD_SECONDS}s: ` +
              "its consumer is stuck, throttled or failing, and the eligibility snapshot is going stale for " +
              "the members it covers. Check the consumer's errors and the queue's DLQ.",
            namespace: "AWS/SQS",
            metricName: "ApproximateAgeOfOldestMessage",
            dimensions: { QueueName: queueName },
            statistic: "Maximum",
            comparisonOperator: "GreaterThanThreshold",
            threshold: FEED_QUEUE_AGE_THRESHOLD_SECONDS,
            period: 60,
            evaluationPeriods: 2,
            treatMissingData: "notBreaching",
            alarmActions: [args.pageTopicArn],
          },
          { parent: this },
        ),
    );

    // The SnapshotStale alarm treats missing data as notBreaching, so a check that throws
    // (checkHandler) would otherwise go silent. This one pages.
    this.errorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-errors-alarm`,
      {
        name: `boxalarm-${env}-alerting-eligibility-staleness-check-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.lambda.function.name },
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    grantAlertingCmk(name, { stalenessCheck: this.lambda.role }, args.alertingCmkArn, {
      parent: this,
    });

    this.registerOutputs({
      lambda: this.lambda,
      schedule: this.schedule,
      alarm: this.alarm,
      feedQueueAgeAlarms: this.feedQueueAgeAlarms,
      errorsAlarm: this.errorsAlarm,
    });
  }
}
