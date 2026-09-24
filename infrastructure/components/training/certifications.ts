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
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E3-S1/S2/S8-INFRA (#214, #215, #221): certification records, plus the lead-time expiry
 * scanner that also gates alerting eligibility currency (#221 propagates via the
 * cert.expiry.due platform-bus event certExpiredReactor.ts consumes — its consumer wiring
 * belongs to E2-S1's outbox-publisher/platform-bus foundation, already generic).
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

    this.registerOutputs({
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      revokeLambda: this.revokeLambda,
      expiringLambda: this.expiringLambda,
      scannerLambda: this.scannerLambda,
    });
  }
}
