import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { QueueConsumer } from "../messaging/queue-consumer";
import { nerisClientPolicyStatements } from "../neris/neris-config";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface NerisSubmissionWorkerArgs {
  env: string;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  nerisCredentialsSecretArn: pulumi.Input<string>;
  /** Schema pins: the worker deep-picks every payload to the compiled NERIS schema. */
  nerisSchemaBucketArn: pulumi.Input<string>;
  nerisSchemaBucketName: pulumi.Input<string>;
  /** The chief's LOB notification topic (never the alerting page topic). */
  chiefNotificationTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/** Lambda timeout for the worker; the queue's visibility timeout is 6x this. */
export const SUBMISSION_WORKER_TIMEOUT_SECONDS = 90;

/** Name prefix submissionWorker.ts gives every retry schedule it creates. */
export const SUBMISSION_RETRY_SCHEDULE_PREFIX = "neris-submission-retry-";

/**
 * NERIS submission worker (incident-service/neris/submissionWorker.ts). The handler
 * accepts exactly two invocation shapes, and both are wired here:
 *
 *  1. An SQS batch of EventBridge envelopes for `neris.incident.submitted` (written to
 *     the incident outbox by submit/retry and published by IncidentOutboxDrain). It
 *     returns `batchItemFailures`, so the mapping opts into ReportBatchItemFailures.
 *  2. A direct invoke from a one-time EventBridge Scheduler schedule
 *     (`{deptId, incidentId, retryCount}`) that the worker itself creates for
 *     backoff retries. CreateSchedule passes no GroupName, so schedules land in the
 *     `default` group; the worker may create only `neris-submission-retry-*` there,
 *     and the scheduler role it passes may only invoke this function.
 */
export class NerisSubmissionWorker extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly schedulerRole: aws.iam.Role;
  public readonly consumer: QueueConsumer;
  public readonly scheduleResourcePattern: pulumi.Output<string>;
  public readonly failureAlarms: aws.cloudwatch.MetricAlarm[];

  constructor(
    name: string,
    args: NerisSubmissionWorkerArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("NerisSubmissionWorker", args.env);
    super("boxalarm:incident:NerisSubmissionWorker", name, {}, opts);
    const { env } = args;

    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    this.scheduleResourcePattern = pulumi.interpolate`arn:aws:scheduler:${region.name}:${caller.accountId}:schedule/default/${SUBMISSION_RETRY_SCHEDULE_PREFIX}*`;

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-incident-neris-submission-scheduler`,
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

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-submission-worker`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "submission-worker"),
        logGroup: args.logGroup,
        // One report per invocation (batchSize 1). Worst NERIS call chain, 4 s per call
        // (client.ts NERIS_CALL_TIMEOUT_MS): token, 2 adopt GETs, POST, 2 adopt GETs, PUT
        // = 28 s; a 401 on every call adds a token fetch and a repeat each = 76 s. Plus
        // SSM/Secrets/DynamoDB reads on a cold start. The queue's visibility timeout is 6x
        // this (AWS guidance for SQS event sources).
        timeout: SUBMISSION_WORKER_TIMEOUT_SECONDS,
        environment: {
          INCIDENT_TABLE_NAME: args.incidentTableName,
          NERIS_BASE_URL_PARAM: `/boxalarm/${env}/neris/base-url`,
          NERIS_USER_AGENT_PARAM: `/boxalarm/${env}/neris/user-agent`,
          NERIS_CREDENTIALS_SECRET_ID: args.nerisCredentialsSecretArn,
          NERIS_SUBMISSION_SCHEDULER_ROLE_ARN: this.schedulerRole.arn,
          NERIS_SCHEMA_BUCKET_NAME: args.nerisSchemaBucketName,
          // neris/config.ts decides prod vs non-prod from STAGE ?? BOXALARM_ENV;
          // ServiceLambda only sets ENVIRONMENT. Without this, prod would treat itself
          // as non-prod and fail closed against the NERIS production host (N6.4).
          BOXALARM_ENV: env,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.incidentTableArn,
            args.incidentCmkArn,
            args.nerisCredentialsSecretArn,
            this.scheduleResourcePattern,
            args.nerisSchemaBucketArn,
          ])
          .apply(([tableArn, cmkArn, secretArn, schedulePattern, bucketArn]) => [
            {
              // The compiled NERIS payload schema pinned with the report's schema version.
              Sid: "ReadNerisSchemaPins" as const,
              Effect: "Allow" as const,
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/neris-schema/*`],
            },
            {
              // getIncident + appendSubmissionAttempt's TransactWrite (attempt Put,
              // submission Update, last-accepted-payload / open-status / outbox Puts).
              // Query: the NERIS settings copy (DEPT#…#NERIS) and the incident's RESPONSE#
              // unit rows the payload is built from.
              Sid: "IncidentSubmissionAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn],
            },
            {
              Sid: "IncidentCmkAccess" as const,
              Effect: "Allow" as const,
              Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
              Resource: [cmkArn],
            },
            ...nerisClientPolicyStatements(secretArn, env),
            {
              Sid: "CreateSubmissionRetrySchedulesOnly" as const,
              Effect: "Allow" as const,
              Action: ["scheduler:CreateSchedule"],
              Resource: schedulePattern,
            },
          ]),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-pass-scheduler-role`,
      {
        role: this.lambda.role.id,
        policy: this.schedulerRole.arn.apply((roleArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "PassSchedulerRoleOnly",
                Effect: "Allow",
                Action: "iam:PassRole",
                Resource: roleArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-scheduler-role-policy`,
      {
        role: this.schedulerRole.id,
        policy: this.lambda.function.arn.apply((functionArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeSubmissionWorkerOnly",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: functionArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.consumer = new QueueConsumer(
      `${name}-consumer`,
      {
        env,
        busName: args.busName,
        ruleName: `boxalarm-${env}-incident-neris-submission`,
        eventPattern: JSON.stringify({
          source: ["incident-service"],
          "detail-type": ["neris.incident.submitted"],
        }),
        queueName: `boxalarm-${env}-incident-neris-submission-queue`,
        lambda: this.lambda.function,
        lambdaRole: this.lambda.role,
        alarmTopicArn: args.chiefNotificationTopicArn,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
        batchSize: 1,
        visibilityTimeoutSeconds: SUBMISSION_WORKER_TIMEOUT_SECONDS * 6,
      },
      { parent: this },
    );

    // Terminal failures the report owner cannot fix alone (review M6): a 401/403/404 from
    // NERIS (credentials revoked, wrong entity id) and a department not configured for
    // NERIS. Both page the chief's LOB topic on the first occurrence.
    this.failureAlarms = [
      [
        "ClientError",
        "NERIS refused the department's credentials, entity id or a record id (HTTP 401/403/404).",
      ],
      [
        "NotConfigured",
        "A locked report could not be sent: the department NERIS id or the NERIS schema is missing.",
      ],
    ].map(
      ([metricName, description]) =>
        new aws.cloudwatch.MetricAlarm(
          `${name}-${metricName!.toLowerCase()}-alarm`,
          {
            name: `boxalarm-${env}-incident-neris-${metricName!.toLowerCase()}`,
            alarmDescription: description!,
            namespace: "Boxalarm/incident-service",
            metricName: metricName!,
            statistic: "Sum",
            period: 300,
            evaluationPeriods: 1,
            threshold: 0,
            comparisonOperator: "GreaterThanThreshold",
            treatMissingData: "notBreaching",
            alarmActions: [args.chiefNotificationTopicArn],
          },
          { parent: this },
        ),
    );

    this.registerOutputs({
      lambda: this.lambda,
      schedulerRole: this.schedulerRole,
      consumer: this.consumer,
    });
  }
}
