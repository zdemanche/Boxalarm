import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface CertificationsArgs {
  env: string;
  deptId: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  platformBusName: pulumi.Input<string>;
  platformBusArn: pulumi.Input<string>;
  platformTableStreamArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E3-S1/S2/S8-INFRA (#214, #215, #221): certification records, plus the lead-time expiry
 * scanner that also gates alerting eligibility currency. #221's propagation chain is a
 * DynamoDB Streams consumer on the platform table (events/certExpiredReactor.ts, filtered to
 * entityType=CERTIFICATION) — a second, independent stream mapping alongside the shared
 * OutboxPublisher's own OUTBOX_ENTRY-filtered mapping, not something that foundation covers.
 * Training records share the platform table (no dedicated training table exists) — both
 * TRAINING_TABLE_NAME (client.ts) and TRAINING_DYNAMO_TABLE_NAME (dynamoClient.ts) point
 * at it, and PLATFORM_CONFIG_DYNAMO_TABLE_NAME (per-dept CONFIG#ALERT_RULES lead-time) too.
 *
 * NOT wired here: attachmentUpload.ts's CloudFront signed-URL upload path
 * (CLOUDFRONT_DISTRIBUTION_DOMAIN / _KEY_PAIR_ID / _PRIVATE_KEY_SECRET_ID). CloudFront is a
 * global-edge service and residency-encryption.test.ts enforces N6.1 (U.S.-only, no global
 * edge) repo-wide — provisioning it here would fail that gate. createCertification without
 * an attachmentFilename works; a request that includes one reaches
 * readAttachmentUploadConfig() and fails closed with a 503, since none of those three env
 * vars are set. Fixing this needs a region-pinned replacement (e.g. S3 presigned PutObject)
 * in attachmentUpload.ts itself — backend work outside this infra ticket's footprint.
 */
export class Certifications extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly listLambda: ServiceLambda;
  public readonly revokeLambda: ServiceLambda;
  public readonly expiringLambda: ServiceLambda;
  public readonly scannerLambda: ServiceLambda;
  public readonly scannerSchedule: aws.scheduler.Schedule;
  public readonly certExpiredReactorLambda: ServiceLambda;
  public readonly certExpiredReactorOnFailureQueue: aws.sqs.Queue;
  public readonly certExpiredReactorEventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly certExpiredReactorOnFailureAlarm: aws.cloudwatch.MetricAlarm;
  public readonly eligibilityFlipFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: CertificationsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Certifications", args.env);
    super("boxalarm:training:Certifications", name, {}, opts);
    const { env } = args;

    const baseEnvironment = {
      TRAINING_TABLE_NAME: args.platformTableName,
      TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);
    const readWriteStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "CertificationsReadWriteAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
        Resource: [arn],
      },
    ]);
    const readOnlyStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "CertificationsReadAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Resource: [arn],
      },
    ]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-create"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([readWriteStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      {
        routeKey: "POST /api/v1/training/members/{memberId}/certifications",
        lambda: this.createLambda,
      },
      { parent: this },
    );

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-list`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-list"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([readOnlyStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      {
        routeKey: "GET /api/v1/training/members/{memberId}/certifications",
        lambda: this.listLambda,
      },
      { parent: this },
    );

    this.revokeLambda = new ServiceLambda(
      `${name}-revoke`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-revoke`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-revoke"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([readWriteStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-revoke-route`,
      {
        routeKey: "POST /api/v1/training/members/{memberId}/certifications/{certId}/revoke",
        lambda: this.revokeLambda,
      },
      { parent: this },
    );

    this.expiringLambda = new ServiceLambda(
      `${name}-expiring`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-expiring`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-expiring"),
        logGroup: args.logGroup,
        environment: {
          ...baseEnvironment,
          PLATFORM_CONFIG_DYNAMO_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([readOnlyStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-expiring-route`,
      { routeKey: "GET /api/v1/training/certifications/expiring", lambda: this.expiringLambda },
      { parent: this },
    );

    this.scannerLambda = new ServiceLambda(
      `${name}-scanner`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-cert-expiry-scanner`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certification-expiry-scanner"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_CONFIG_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_EVENT_BUS_NAME: args.platformBusName,
          TRAINING_SCANNER_DEPT_ID: args.deptId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.platformBusArn])
          .apply(([tableArn, busArn]) => [
            {
              Sid: "CertExpiryScannerTableAccess" as const,
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
              Sid: "CertExpiryScannerPublish" as const,
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
          ]),
      },
      { parent: this },
    );

    const schedulerRole = new aws.iam.Role(
      `${name}-scanner-scheduler-role`,
      {
        name: `boxalarm-${env}-training-cert-expiry-scheduler`,
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
      `${name}-scanner-scheduler-role-policy`,
      {
        role: schedulerRole.id,
        policy: this.scannerLambda.function.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeCertExpiryScanner",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.scannerSchedule = new aws.scheduler.Schedule(
      `${name}-scanner-schedule`,
      {
        name: `boxalarm-${env}-training-cert-expiry-scanner-daily`,
        scheduleExpression: "rate(1 day)",
        flexibleTimeWindow: { mode: "OFF" },
        target: { arn: this.scannerLambda.function.arn, roleArn: schedulerRole.arn },
      },
      { parent: this },
    );

    // #114/#204/#221: platform-table stream -> certExpiredReactor.ts, filtered to
    // entityType=CERTIFICATION at the EventSourceMapping (not in code) so no other
    // entityType invokes this Lambda. readPersonnelServiceConfig (awsClients.ts) requires
    // both PERSONNEL_TABLE_NAME and PLATFORM_BUS_NAME, even though this reactor only writes
    // to the table itself — flipEligibilityOnCertExpired publishes via the same OUTBOX_ENTRY
    // shape the already-deployed shared OutboxPublisher consumes, so no events:PutEvents grant.
    this.certExpiredReactorLambda = new ServiceLambda(
      `${name}-cert-expired-reactor`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-cert-expired-reactor`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "cert-expired-reactor"),
        logGroup: args.logGroup,
        environment: {
          PERSONNEL_TABLE_NAME: args.platformTableName,
          PLATFORM_BUS_NAME: args.platformBusName,
        },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((tableArn) => [
          {
            Sid: "CertExpiredReactorAccess" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:Query", "dynamodb:TransactWriteItems"],
            Resource: [tableArn],
          },
        ]),
      },
      { parent: this },
    );

    this.certExpiredReactorOnFailureQueue = new aws.sqs.Queue(
      `${name}-cert-expired-reactor-onfailure`,
      { name: `boxalarm-${env}-cert-expired-reactor-onfailure` },
      { parent: this },
    );

    this.certExpiredReactorEventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-cert-expired-reactor-esm`,
      {
        eventSourceArn: args.platformTableStreamArn,
        functionName: this.certExpiredReactorLambda.function.name,
        startingPosition: "LATEST",
        batchSize: 10,
        bisectBatchOnFunctionError: true,
        maximumRetryAttempts: 5,
        maximumRecordAgeInSeconds: 3600,
        functionResponseTypes: ["ReportBatchItemFailures"],
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                dynamodb: { NewImage: { entityType: { S: ["CERTIFICATION"] } } },
              }),
            },
          ],
        },
        destinationConfig: {
          onFailure: { destinationArn: this.certExpiredReactorOnFailureQueue.arn },
        },
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-cert-expired-reactor-stream-read-policy`,
      {
        role: this.certExpiredReactorLambda.role.id,
        policy: pulumi.output(args.platformTableStreamArn).apply((streamArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadPlatformTableStream",
                Effect: "Allow",
                Action: [
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:DescribeStream",
                  "dynamodb:ListStreams",
                ],
                Resource: streamArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.certExpiredReactorOnFailureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-cert-expired-reactor-onfailure-alarm`,
      {
        name: `boxalarm-${env}-cert-expired-reactor-onfailure-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.certExpiredReactorOnFailureQueue.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.eligibilityFlipFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-eligibility-flip-failed-alarm`,
      {
        name: `boxalarm-${env}-training-eligibility-flip-failed`,
        namespace: "Boxalarm/personnel-service",
        metricName: "EligibilityFlipFailed",
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
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      revokeLambda: this.revokeLambda,
      expiringLambda: this.expiringLambda,
      scannerLambda: this.scannerLambda,
      certExpiredReactorLambda: this.certExpiredReactorLambda,
    });
  }
}
