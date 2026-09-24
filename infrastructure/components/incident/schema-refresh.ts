import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface SchemaRefreshArgs {
  env: string;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  nerisSchemaSourceUrl: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/**
 * boxalarm-{env}-incident-assets bucket + the daily scheduled NERIS schema
 * refresh (E6-S11-INFRA #246). PutObject only on the schema-pin prefix, no
 * DeleteObject — N-1 pins survive so an incident validated under the prior
 * version keeps working (AC2).
 */
export class SchemaRefresh extends pulumi.ComponentResource {
  public readonly bucket: aws.s3.Bucket;
  public readonly refreshLambda: ServiceLambda;
  public readonly schedule: aws.scheduler.Schedule;
  public readonly schedulerRole: aws.iam.Role;
  public readonly refreshErrorsAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: SchemaRefreshArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("SchemaRefresh", args.env);
    super("boxalarm:incident:SchemaRefresh", name, {}, opts);
    const { env } = args;

    this.bucket = new aws.s3.Bucket(
      `${name}-bucket`,
      { bucket: `boxalarm-${env}-incident-assets`, forceDestroy: false },
      { parent: this },
    );

    new aws.s3.BucketPublicAccessBlock(
      `${name}-bucket-block`,
      {
        bucket: this.bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );

    new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${name}-bucket-sse`,
      {
        bucket: this.bucket.id,
        rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
      },
      { parent: this },
    );

    new aws.s3.BucketVersioningV2(
      `${name}-bucket-versioning`,
      { bucket: this.bucket.id, versioningConfiguration: { status: "Disabled" } },
      { parent: this },
    );

    new aws.s3.BucketLifecycleConfigurationV2(
      `${name}-bucket-lifecycle`,
      {
        bucket: this.bucket.id,
        rules: [
          {
            id: "abort-incomplete-multipart-and-intelligent-tiering",
            status: "Enabled",
            abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
            transitions: [{ days: 0, storageClass: "INTELLIGENT_TIERING" }],
          },
        ],
      },
      { parent: this },
    );

    this.refreshLambda = new ServiceLambda(
      `${name}-refresh-lambda`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-neris-schema-refresh`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "schema-version-refresh"),
        logGroup: args.logGroup,
        timeout: 60,
        environment: {
          INCIDENT_TABLE_NAME: args.incidentTableName,
          NERIS_SCHEMA_BUCKET_NAME: this.bucket.bucket,
          NERIS_SCHEMA_SOURCE_URL: args.nerisSchemaSourceUrl,
        },
        additionalPolicyStatements: pulumi
          .all([args.incidentCmkArn, args.incidentTableArn, this.bucket.arn])
          .apply(([cmkArn, tableArn, bucketArn]) => [
            {
              Sid: "SchemaVersionTableAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
              Resource: [tableArn],
            },
            {
              Sid: "SchemaVersionCmkAccess" as const,
              Effect: "Allow" as const,
              Action: ["kms:Encrypt", "kms:GenerateDataKey"],
              Resource: [cmkArn],
            },
            {
              // No s3:DeleteObject and no wildcard outside the pin prefix (AC2).
              Sid: "WriteNerisSchemaPins" as const,
              Effect: "Allow" as const,
              Action: ["s3:PutObject"],
              Resource: [`${bucketArn}/neris-schema/*`],
            },
          ]),
      },
      { parent: this },
    );

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-incident-schema-refresh-scheduler`,
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

    new aws.iam.RolePolicy(
      `${name}-scheduler-invoke-policy`,
      {
        role: this.schedulerRole.id,
        policy: this.refreshLambda.function.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeSchemaRefreshLambda",
                Effect: "Allow",
                Action: ["lambda:InvokeFunction"],
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.schedule = new aws.scheduler.Schedule(
      `${name}-schedule`,
      {
        name: `boxalarm-${env}-incident-neris-schema-refresh`,
        scheduleExpression: "rate(1 day)",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.refreshLambda.function.arn,
          roleArn: this.schedulerRole.arn,
        },
      },
      { parent: this },
    );

    this.refreshErrorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-refresh-errors-alarm`,
      {
        name: `boxalarm-${env}-incident-neris-schema-refresh-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.refreshLambda.function.name },
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.registerOutputs({
      bucket: this.bucket,
      refreshLambda: this.refreshLambda,
      schedule: this.schedule,
    });
  }
}
