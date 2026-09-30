import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { nerisClientPolicyStatements } from "../neris/neris-config";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { ScheduleDeadLetter } from "../shared/schedule-dead-letter";
import { requireEnv } from "../shared/env";

export interface NerisSyncArgs {
  env: string;
  /** Department(s) the scheduled jobs sweep (comma-separated; single-tenant today). */
  deptId: pulumi.Input<string>;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  nerisCredentialsSecretArn: pulumi.Input<string>;
  /** The chief's LOB notification topic (never the alerting page topic). */
  chiefNotificationTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/** Every 5 minutes: records NERIS still holds in SUBMITTED / PENDING_*. */
export const NERIS_STATUS_POLL_SCHEDULE = "rate(5 minutes)";
/** 03:15 New York time, after the day's calls and before the morning. */
export const NERIS_RECONCILIATION_SCHEDULE = "cron(15 3 * * ? *)";
export const NERIS_RECONCILIATION_TIMEZONE = "America/New_York";

interface JobSpec {
  key: "neris-status-poller" | "neris-reconciliation";
  scheduleExpression: string;
  scheduleExpressionTimezone?: string;
  timeout: number;
  statements: (tableArn: string) => IamPolicyStatement[];
}

/**
 * The scheduled half of the NERIS loop (incident-service/neris/statusPoller.ts and
 * reconciliation.ts): EventBridge Scheduler -> Lambda, one scheduler role that may invoke
 * only these two functions, an Errors alarm on each. Both read the NERIS OAuth secret; the
 * poller writes status rows and the outbox, the reconciliation writes its run row, the
 * no-activity reminder marker and the outbox. Neither is on the alerting plane.
 */
export class NerisSync extends pulumi.ComponentResource {
  public readonly lambdas: Record<JobSpec["key"], ServiceLambda>;
  public readonly schedules: aws.scheduler.Schedule[] = [];
  public readonly schedulerRole: aws.iam.Role;
  public readonly pollFailedAlarm: aws.cloudwatch.MetricAlarm;
  /** Poll expiry, reconciliation drift and give-up alarms (round 2, N6). */
  public readonly driftAlarms: aws.cloudwatch.MetricAlarm[];

  constructor(name: string, args: NerisSyncArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("NerisSync", args.env);
    super("boxalarm:incident:NerisSync", name, {}, opts);
    const { env } = args;

    const jobs: JobSpec[] = [
      {
        key: "neris-status-poller",
        scheduleExpression: NERIS_STATUS_POLL_SCHEDULE,
        // Up to 200 history reads a run; well inside the 5-minute cadence.
        timeout: 240,
        statements: (tableArn) => [
          {
            // Query: settings copy + NERIS_OPEN work list. GetItem: METADATA. Transaction:
            // METADATA Update, NERIS#STATUS# and outbox Puts, NERIS_OPEN Delete.
            Sid: "NerisStatusPollAccess",
            Effect: "Allow",
            Action: [
              "dynamodb:Query",
              "dynamodb:GetItem",
              "dynamodb:UpdateItem",
              "dynamodb:PutItem",
              "dynamodb:DeleteItem",
            ],
            Resource: [tableArn],
          },
        ],
      },
      {
        key: "neris-reconciliation",
        scheduleExpression: NERIS_RECONCILIATION_SCHEDULE,
        scheduleExpressionTimezone: NERIS_RECONCILIATION_TIMEZONE,
        timeout: 300,
        statements: (tableArn) => [
          {
            // GSI1: the window's incidents (and a closed month's count). Table: settings
            // copy, filed/reminded-month rows, run row, outbox Puts; repairing drift applies
            // the NERIS status (METADATA Update, history Puts, work-list Put or Delete).
            Sid: "NerisReconciliationAccess",
            Effect: "Allow",
            Action: [
              "dynamodb:Query",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
            ],
            Resource: [tableArn, `${tableArn}/index/GSI1`],
          },
        ],
      },
    ];

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-incident-neris-sync-scheduler`,
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
      },
      { parent: this },
    );

    const lambdas = {} as Record<JobSpec["key"], ServiceLambda>;
    for (const job of jobs) {
      const lambda = new ServiceLambda(
        `${name}-${job.key}`,
        {
          env,
          serviceName: "incident-service",
          functionName: `boxalarm-${env}-incident-${job.key}`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("incident-service", job.key),
          logGroup: args.logGroup,
          timeout: job.timeout,
          environment: {
            INCIDENT_TABLE_NAME: args.incidentTableName,
            NERIS_SCANNER_DEPT_ID: args.deptId,
            NERIS_BASE_URL_PARAM: `/boxalarm/${env}/neris/base-url`,
            NERIS_USER_AGENT_PARAM: `/boxalarm/${env}/neris/user-agent`,
            NERIS_CREDENTIALS_SECRET_ID: args.nerisCredentialsSecretArn,
            BOXALARM_ENV: env,
          },
          additionalPolicyStatements: pulumi
            .all([args.incidentTableArn, args.incidentCmkArn, args.nerisCredentialsSecretArn])
            .apply(([tableArn, cmkArn, secretArn]): IamPolicyStatement[] => [
              ...job.statements(tableArn),
              {
                Sid: "IncidentCmkAccess",
                Effect: "Allow",
                Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
                Resource: [cmkArn],
              },
              ...nerisClientPolicyStatements(secretArn, env),
            ]),
        },
        { parent: this },
      );
      lambdas[job.key] = lambda;

      const deadLetter = new ScheduleDeadLetter(
        `${name}-${job.key}-schedule-dead-letter`,
        {
          queueName: `boxalarm-${env}-incident-${job.key}-scheduler-dlq`,
          schedulerRole: this.schedulerRole,
          alarmActions: [args.chiefNotificationTopicArn],
        },
        { parent: this },
      );
      this.schedules.push(
        new aws.scheduler.Schedule(
          `${name}-${job.key}-schedule`,
          {
            name: `boxalarm-${env}-incident-${job.key}`,
            scheduleExpression: job.scheduleExpression,
            ...(job.scheduleExpressionTimezone
              ? { scheduleExpressionTimezone: job.scheduleExpressionTimezone }
              : {}),
            flexibleTimeWindow: { mode: "OFF" },
            target: {
              arn: lambda.function.arn,
              roleArn: this.schedulerRole.arn,
              ...deadLetter.targetConfig,
            },
          },
          { parent: this },
        ),
      );

      new aws.cloudwatch.MetricAlarm(
        `${name}-${job.key}-errors-alarm`,
        {
          name: `boxalarm-${env}-incident-${job.key}-errors`,
          namespace: "AWS/Lambda",
          metricName: "Errors",
          dimensions: { FunctionName: lambda.function.name },
          statistic: "Sum",
          period: 900,
          evaluationPeriods: 1,
          threshold: 0,
          comparisonOperator: "GreaterThanThreshold",
          treatMissingData: "notBreaching",
          alarmActions: [args.chiefNotificationTopicArn],
        },
        { parent: this },
      );
    }
    this.lambdas = lambdas;

    // The poller catches per-record failures (so Lambda Errors stays 0) and emits
    // NerisStatusPollFailed instead. Three failing 15-minute periods in a row (a credentials
    // or NERIS outage, not one flaky record) page the chief (review M6).
    this.pollFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-poll-failed-alarm`,
      {
        name: `boxalarm-${env}-incident-neris-status-poll-failed`,
        alarmDescription:
          "The NERIS status poller has been failing for 45 minutes: rejections are not reaching report owners.",
        namespace: "Boxalarm/neris-status-poller",
        metricName: "NerisStatusPollFailed",
        statistic: "Sum",
        period: 900,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [args.chiefNotificationTopicArn],
      },
      { parent: this },
    );

    // A record the poller stopped watching, drift the nightly reconciliation found, and a
    // record given up on as no longer in NERIS each reach the chief's LOB topic on the first
    // occurrence: before, they were visible only on the RECONCILIATION#LAST row (round 2, N6).
    this.driftAlarms = (
      [
        [
          "poll-expired",
          "Boxalarm/neris-status-poller",
          "NerisStatusPollExpired",
          "The NERIS status poller stopped watching a report (60 days old or 12 failed checks). Its NERIS status may be stale.",
        ],
        [
          "drift-detected",
          "Boxalarm/neris-reconciliation",
          // New drift only (round 2b, R4): a difference that persists night after night (e.g.
          // records another system filed) pages once, not every night.
          "ReconciliationNewDrift",
          "The nightly NERIS reconciliation found new differences between NERIS and Boxalarm (see the department's RECONCILIATION#LAST row).",
        ],
        [
          "record-missing",
          "Boxalarm/neris-reconciliation",
          "NerisRecordMissing",
          "NERIS no longer lists a report it had accepted, after repeated nightly checks. The owner and officers were notified.",
        ],
      ] as const
    ).map(
      ([key, namespace, metricName, description]) =>
        new aws.cloudwatch.MetricAlarm(
          `${name}-${key}-alarm`,
          {
            name: `boxalarm-${env}-incident-neris-${key}`,
            alarmDescription: description,
            namespace,
            metricName,
            statistic: "Sum",
            period: 3600,
            evaluationPeriods: 1,
            threshold: 0,
            comparisonOperator: "GreaterThanThreshold",
            treatMissingData: "notBreaching",
            alarmActions: [args.chiefNotificationTopicArn],
          },
          { parent: this },
        ),
    );

    new aws.iam.RolePolicy(
      `${name}-scheduler-invoke-policy`,
      {
        role: this.schedulerRole.id,
        policy: pulumi
          .all(Object.values(lambdas).map((lambda) => lambda.function.arn))
          .apply((arns) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "InvokeNerisSyncJobsOnly",
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: arns,
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    this.registerOutputs({ lambdas: this.lambdas, schedules: this.schedules });
  }
}
