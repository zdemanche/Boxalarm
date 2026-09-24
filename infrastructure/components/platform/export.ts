import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { observabilityPolicyStatements } from "../observability/observability-policy";
import { ACTIVE_TRACING_CONFIG } from "../observability/xray-sampling";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface ExportArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  alertingTableArn: pulumi.Input<string>;
  alertingCmkArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  chiefNotificationTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** E8-S6-INFRA #258 full department data export. */
export class Export extends pulumi.ComponentResource {
  public readonly stagingBucket: aws.s3.Bucket;
  public readonly stagingBucketLifecycle: aws.s3.BucketLifecycleConfigurationV2;
  public readonly workerRole: aws.iam.Role;
  public readonly workerRolePolicy: aws.iam.RolePolicy;
  public readonly workerLambda: aws.lambda.Function;
  public readonly handlerLambda: ServiceLambda;
  public readonly invokedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly workerFailedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly exportFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: ExportArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Export", args.env);
    super("boxalarm:platform:Export", name, {}, opts);
    const { env } = args;
    // NOT metricsNamespaceFor("platform-service") (Boxalarm/platform-service): the
    // backend emits ExportInvoked/ExportWorkerInvokeFailed/ExportFailed to the
    // literal namespace "Boxalarm/platform" (export/handler.ts, export/worker.ts).
    // Watching the wrong namespace meant these alarms — the stated compensating
    // control for "Cedar role check alone" on every export — could never fire.
    const namespace = "Boxalarm/platform";

    // S3 bucket names are globally unique across ALL AWS accounts and regions.
    // A bare "boxalarm-exports-staging" literal means only the first stack to
    // deploy ever creates the bucket — in a single account (all stacks pinned
    // to us-east-1), every other stack's CreateBucket silently no-ops and
    // adopts the SAME bucket, so dev's export role can read prod's full
    // department exports. Env-scoping the name gives each stack its own bucket.
    this.stagingBucket = new aws.s3.Bucket(
      `${name}-staging`,
      { bucket: `boxalarm-${env}-exports-staging`, forceDestroy: false },
      { parent: this },
    );

    new aws.s3.BucketPublicAccessBlock(
      `${name}-staging-block`,
      {
        bucket: this.stagingBucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );

    new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${name}-staging-sse`,
      {
        bucket: this.stagingBucket.id,
        rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
      },
      { parent: this },
    );

    this.stagingBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2(
      `${name}-staging-lifecycle`,
      {
        bucket: this.stagingBucket.id,
        rules: [
          {
            id: "expire-and-abort-multipart",
            status: "Enabled",
            expiration: { days: 7 },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
          },
        ],
      },
      { parent: this },
    );

    this.workerRole = new aws.iam.Role(
      `${name}-worker-role`,
      {
        name: `boxalarm-${env}-platform-export-readonly`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this },
    );

    this.workerRolePolicy = new aws.iam.RolePolicy(
      `${name}-worker-role-policy`,
      {
        role: this.workerRole.id,
        policy: pulumi
          .all([
            args.platformTableArn,
            args.incidentTableArn,
            args.alertingTableArn,
            args.alertingCmkArn,
            args.incidentCmkArn,
            this.stagingBucket.arn,
            args.logGroup.logGroup.arn,
          ])
          .apply(
            ([
              platformArn,
              incidentArn,
              alertingArn,
              alertingCmk,
              incidentCmk,
              bucketArn,
              logGroupArn,
            ]) =>
              JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  ...observabilityPolicyStatements(logGroupArn, "platform-service"),
                  {
                    Sid: "ReadOnlyAllTables",
                    Effect: "Allow",
                    Action: [
                      "dynamodb:Scan",
                      "dynamodb:Query",
                      "dynamodb:GetItem",
                      "dynamodb:DescribeTable",
                    ],
                    Resource: [
                      platformArn,
                      `${platformArn}/index/*`,
                      incidentArn,
                      `${incidentArn}/index/*`,
                      alertingArn,
                      `${alertingArn}/index/*`,
                    ],
                  },
                  {
                    Sid: "DecryptArchiveCmks",
                    Effect: "Allow",
                    Action: ["kms:Decrypt"],
                    Resource: [alertingCmk, incidentCmk],
                  },
                  {
                    Sid: "WriteExportsBucket",
                    Effect: "Allow",
                    Action: [
                      "s3:PutObject",
                      "s3:AbortMultipartUpload",
                      "s3:ListMultipartUploadParts",
                    ],
                    Resource: `${bucketArn}/*`,
                  },
                ],
              }),
          ),
      },
      { parent: this },
    );

    this.workerLambda = new aws.lambda.Function(
      `${name}-worker-fn`,
      {
        name: `boxalarm-${env}-platform-export-worker`,
        runtime: aws.lambda.Runtime.NodeJS20dX,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        role: this.workerRole.arn,
        code: placeholderLambdaCode(),
        timeout: 900,
        tracingConfig: ACTIVE_TRACING_CONFIG,
        loggingConfig: { logFormat: "JSON", logGroup: args.logGroup.logGroupName },
        environment: {
          variables: {
            SERVICE_NAME: "platform-service",
            ENVIRONMENT: env,
            // worker.ts scans its tables in order starting with alerting-service
            // (TABLES/ALERTING_TABLE_NAME) — empty strings made every Scan raise a
            // ValidationException, so every export failed immediately.
            ALERTING_TABLE_NAME: args.alertingTableName,
            INCIDENT_TABLE_NAME: args.incidentTableName,
            PLATFORM_TABLE_NAME: args.platformTableName,
            EXPORT_BUCKET_NAME: this.stagingBucket.bucket,
          },
        },
      },
      { parent: this, dependsOn: [args.logGroup.logGroup] },
    );

    this.handlerLambda = new ServiceLambda(
      `${name}-handler`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-export`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          EXPORT_WORKER_FUNCTION_NAME: this.workerLambda.name,
          EXPORT_BUCKET_NAME: this.stagingBucket.bucket,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, this.workerLambda.arn, this.stagingBucket.arn])
          .apply(([platformArn, workerArn, bucketArn]) => [
            {
              // dynamodb:TransactWriteItems is not a real IAM action — DynamoDB
              // authorizes each item inside a transaction as its own PutItem/
              // UpdateItem/DeleteItem call. handlePost's TransactWriteCommand sends
              // two Puts (the EXPORT_JOB item and its AUDIT_LOG_ENTRY), handleGet
              // does a GetItem, and markJobFailed does an UpdateItem. Granting
              // TransactWriteItems and no PutItem meant POST /platform/export was
              // denied on every call.
              Sid: "ExportTableAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: platformArn,
            },
            {
              Sid: "InvokeExportWorker" as const,
              Effect: "Allow" as const,
              Action: ["lambda:InvokeFunction"],
              Resource: workerArn,
            },
            {
              Sid: "ReadExportBucket" as const,
              Effect: "Allow" as const,
              Action: ["s3:HeadObject", "s3:GetObject"],
              Resource: `${bucketArn}/*`,
            },
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-post-route`,
      { routeKey: "POST /api/v1/platform/export", lambda: this.handlerLambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/platform/export/{jobId}", lambda: this.handlerLambda },
      { parent: this },
    );

    const chiefAlarmAction = [args.chiefNotificationTopicArn];

    this.invokedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-invoked-alarm`,
      {
        name: `boxalarm-${env}-platform-export-invoked`,
        namespace,
        metricName: "ExportInvoked",
        statistic: "Sum",
        period: 60,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: chiefAlarmAction,
      },
      { parent: this },
    );

    this.workerFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-worker-failed-alarm`,
      {
        name: `boxalarm-${env}-platform-export-worker-invoke-failed`,
        namespace,
        metricName: "ExportWorkerInvokeFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: chiefAlarmAction,
      },
      { parent: this },
    );

    this.exportFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-export-failed-alarm`,
      {
        name: `boxalarm-${env}-platform-export-failed`,
        namespace,
        metricName: "ExportFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: chiefAlarmAction,
      },
      { parent: this },
    );

    this.registerOutputs({
      stagingBucket: this.stagingBucket,
      workerLambda: this.workerLambda,
      handlerLambda: this.handlerLambda,
    });
  }
}
