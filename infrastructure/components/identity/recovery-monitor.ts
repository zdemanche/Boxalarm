import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface RecoveryMonitorArgs {
  env: string;
  logGroup: ServiceLogGroup;
}

const RECOVERY_EVENT_NAMES = ["ForgotPassword", "ConfirmForgotPassword"];

/**
 * E8-S2-INFRA #254: CloudTrail on Cognito user-pool API calls → default-bus
 * rule → credential-recovery-monitor/handler.ts, with alarms on its Recovery*
 * metrics. Account-takeover monitoring for the only self-service recovery path.
 */
export class RecoveryMonitor extends pulumi.ComponentResource {
  public readonly trailBucket: aws.s3.Bucket;
  public readonly trail: aws.cloudtrail.Trail;
  public readonly lambda: ServiceLambda;
  public readonly rule: aws.cloudwatch.EventRule;
  public readonly dlq: aws.sqs.Queue;
  public readonly recoveryFailedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly classificationFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: RecoveryMonitorArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RecoveryMonitor", args.env);
    super("boxalarm:identity:RecoveryMonitor", name, {}, opts);
    const { env } = args;
    // NOT metricsNamespaceFor("platform-service") (Boxalarm/platform-service): the
    // backend emits RecoveryFailed/RecoveryClassificationFailed (and
    // RecoveryStarted/RecoveryCompleted) to the literal namespace
    // "Boxalarm/credential-recovery" (credential-recovery-monitor/handler.ts).
    // Watching the wrong namespace meant these account-takeover alarms could never
    // fire.
    const namespace = "Boxalarm/credential-recovery";

    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    const region = aws.getRegionOutput({}, { parent: this });
    const trailName = `boxalarm-${env}-cognito-management-events`;

    this.trailBucket = new aws.s3.Bucket(
      `${name}-trail-bucket`,
      { bucket: `boxalarm-${env}-cognito-trail`, forceDestroy: false },
      { parent: this },
    );

    new aws.s3.BucketPublicAccessBlock(
      `${name}-trail-bucket-block`,
      {
        bucket: this.trailBucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );

    const bucketPolicy = new aws.s3.BucketPolicy(
      `${name}-trail-bucket-policy`,
      {
        bucket: this.trailBucket.id,
        policy: pulumi
          .all([this.trailBucket.arn, caller.accountId, region.name])
          .apply(([bucketArn, accountId, regionName]) => {
            const trailArn = `arn:aws:cloudtrail:${regionName}:${accountId}:trail/${trailName}`;
            return JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "AWSCloudTrailAclCheck",
                  Effect: "Allow",
                  Principal: { Service: "cloudtrail.amazonaws.com" },
                  Action: "s3:GetBucketAcl",
                  Resource: bucketArn,
                  Condition: {
                    StringEquals: { "aws:SourceAccount": accountId },
                    ArnLike: { "aws:SourceArn": trailArn },
                  },
                },
                {
                  Sid: "AWSCloudTrailWrite",
                  Effect: "Allow",
                  Principal: { Service: "cloudtrail.amazonaws.com" },
                  Action: "s3:PutObject",
                  Resource: `${bucketArn}/AWSLogs/${accountId}/*`,
                  Condition: {
                    StringEquals: {
                      "s3:x-amz-acl": "bucket-owner-full-control",
                      "aws:SourceAccount": accountId,
                    },
                    ArnLike: { "aws:SourceArn": trailArn },
                  },
                },
              ],
            });
          }),
      },
      { parent: this },
    );

    this.trail = new aws.cloudtrail.Trail(
      `${name}-trail`,
      {
        name: trailName,
        s3BucketName: this.trailBucket.bucket,
        includeGlobalServiceEvents: false,
        isMultiRegionTrail: false,
        enableLogFileValidation: true,
        eventSelectors: [{ readWriteType: "WriteOnly", includeManagementEvents: true }],
      },
      { parent: this, dependsOn: [bucketPolicy] },
    );

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-credential-recovery-monitor`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
      },
      { parent: this },
    );

    this.dlq = new aws.sqs.Queue(
      `${name}-target-dlq`,
      { name: `boxalarm-${env}-credential-recovery-monitor-dlq` },
      { parent: this },
    );

    this.rule = new aws.cloudwatch.EventRule(
      `${name}-rule`,
      {
        name: `boxalarm-${env}-credential-recovery-monitor`,
        eventPattern: JSON.stringify({
          source: ["aws.cognito-idp"],
          "detail-type": ["AWS API Call via CloudTrail"],
          detail: { eventName: RECOVERY_EVENT_NAMES },
        }),
      },
      { parent: this, dependsOn: [this.trail] },
    );

    new aws.lambda.Permission(
      `${name}-invoke-permission`,
      {
        action: "lambda:InvokeFunction",
        function: this.lambda.function.name,
        principal: "events.amazonaws.com",
        sourceArn: this.rule.arn,
      },
      { parent: this },
    );

    new aws.cloudwatch.EventTarget(
      `${name}-target`,
      {
        rule: this.rule.name,
        arn: this.lambda.function.arn,
        deadLetterConfig: { arn: this.dlq.arn },
      },
      { parent: this },
    );

    this.recoveryFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-recovery-failed-alarm`,
      {
        name: `boxalarm-${env}-credential-recovery-failed`,
        namespace,
        metricName: "RecoveryFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 5,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.classificationFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-classification-failed-alarm`,
      {
        name: `boxalarm-${env}-credential-recovery-classification-failed`,
        namespace,
        metricName: "RecoveryClassificationFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.registerOutputs({ trail: this.trail, lambda: this.lambda });
  }
}
