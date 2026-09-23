import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { dynamodbCmkPolicy } from "../data/cmk-policy";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface RetentionArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  chiefNotificationTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** E8-S9-INFRA #260 records retention: daily schedule + admin route, disposal role, crypto-shred CMKs. */
export class Retention extends pulumi.ComponentResource {
  public readonly archivedIncidentCmk: aws.kms.Key;
  public readonly archivedDeliveryReceiptCmk: aws.kms.Key;
  public readonly disposalLambda: ServiceLambda;
  public readonly schedule: aws.scheduler.Schedule;
  public readonly invokedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: RetentionArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Retention", args.env);
    super("boxalarm:platform:Retention", name, {}, opts);
    const { env } = args;

    const caller = aws.getCallerIdentityOutput({}, { parent: this });

    this.archivedIncidentCmk = new aws.kms.Key(
      `${name}-archived-incident-cmk`,
      {
        description: `Crypto-shred CMK for boxalarm-${env} archived incident records`,
        enableKeyRotation: true,
        policy: caller.accountId.apply(dynamodbCmkPolicy),
      },
      { parent: this },
    );

    this.archivedDeliveryReceiptCmk = new aws.kms.Key(
      `${name}-archived-delivery-receipt-cmk`,
      {
        description: `Crypto-shred CMK for boxalarm-${env} archived delivery receipts`,
        enableKeyRotation: true,
        policy: caller.accountId.apply(dynamodbCmkPolicy),
      },
      { parent: this },
    );

    this.disposalLambda = new ServiceLambda(
      `${name}-disposal`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-retention-disposal`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: { PLATFORM_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            this.archivedIncidentCmk.arn,
            this.archivedDeliveryReceiptCmk.arn,
            args.policyStoreArn,
          ])
          .apply(([tableArn, archivedIncidentArn, archivedReceiptArn, policyStoreArn]) => [
            {
              Sid: "DisposalLobClassAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
              Resource: tableArn,
            },
            // No incident-table delete grant, and no alerting-table grant at
            // all (DELIVERY_RECEIPT/DISPATCH_ALERT stay unreachable) — the
            // absence of those statements is the enforcement.
            auditMutationDenyStatement(tableArn),
            {
              Sid: "CryptoShredArchiveKeysOnly" as const,
              Effect: "Allow" as const,
              Action: ["kms:ScheduleKeyDeletion"],
              Resource: [archivedIncidentArn, archivedReceiptArn],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-route`,
      { routeKey: "POST /api/v1/platform/retention/disposal", lambda: this.disposalLambda },
      { parent: this },
    );

    const schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-platform-retention-scheduler`,
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
      `${name}-scheduler-role-policy`,
      {
        role: schedulerRole.id,
        policy: this.disposalLambda.function.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeDisposal",
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

    this.schedule = new aws.scheduler.Schedule(
      `${name}-schedule`,
      {
        name: `boxalarm-${env}-platform-retention-disposal-daily`,
        scheduleExpression: "rate(1 day)",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.disposalLambda.function.arn,
          roleArn: schedulerRole.arn,
        },
      },
      { parent: this },
    );

    this.invokedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-invoked-alarm`,
      {
        name: `boxalarm-${env}-platform-retention-disposal-invoked`,
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        dimensions: { FunctionName: this.disposalLambda.function.name },
        statistic: "Sum",
        period: 3600,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [args.chiefNotificationTopicArn],
      },
      { parent: this },
    );

    this.registerOutputs({
      disposalLambda: this.disposalLambda,
      archivedIncidentCmk: this.archivedIncidentCmk,
      archivedDeliveryReceiptCmk: this.archivedDeliveryReceiptCmk,
    });
  }
}
