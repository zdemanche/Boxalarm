import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { dynamodbCmkPolicy } from "../data/cmk-policy";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { ScheduleDeadLetter } from "../shared/schedule-dead-letter";
import { requireEnv } from "../shared/env";

export interface RetentionArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  chiefNotificationTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
  /** The daily discovery sweep's schedule state. Default true. False only disables the
   * non-destructive scan itself (e.g. during initial rollout); never a lever for
   * disposal — runDisposal is never on a schedule regardless of this flag. */
  discoveryEnabled?: boolean;
}

/**
 * E8-S9-INFRA #260 records retention: the retention-config and admin disposal routes, the
 * disposal role, the crypto-shred CMKs, and the daily, read-only candidate-discovery sweep.
 *
 * Disposal itself is never scheduled. runDisposal (disposal.ts) acts only on the
 * explicit pk/sk candidates a CHIEF/ADMIN posts to POST /platform/retention/disposal —
 * no schedule, role, or Lambda in this component ever invokes it. Automatic,
 * unattended hard delete and KMS key destruction on a timer is exactly what the
 * architecture says destructive admin actions must NOT be (Security & Auth: those
 * actions are controlled by "detection and reversal, not prevention" — unconditional
 * alarming plus an admin's own Cedar-gated action, never an automatic trigger).
 *
 * What IS scheduled is the other half of that "detection": discoveryLambda
 * (discoveryHandler.ts) runs daily, scans for rows whose age has crossed the owning
 * department's retention window, and emits DisposalCandidatesFound so
 * candidatesFoundAlarm can notify the chief. It cannot destroy anything — its role
 * grants dynamodb:Scan/GetItem only, nothing that mutates the table. A human still
 * decides whether to act, by posting the disposal candidates to the existing endpoint.
 * This was previously deferred ("nothing in the backend discovers candidates") until a
 * discovery implementation landed (backend discovery.ts/discoveryHandler.ts).
 */
export class Retention extends pulumi.ComponentResource {
  public readonly archivedIncidentCmk: aws.kms.Key;
  public readonly archivedDeliveryReceiptCmk: aws.kms.Key;
  public readonly disposalLambda: ServiceLambda;
  public readonly configLambda: ServiceLambda;
  public readonly discoveryLambda: ServiceLambda;
  public readonly discoverySchedule: aws.scheduler.Schedule;
  public readonly invokedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly candidatesFoundAlarm: aws.cloudwatch.MetricAlarm;
  public readonly discoveryErrorsAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: RetentionArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Retention", args.env);
    super("boxalarm:platform:Retention", name, {}, opts);
    const { env } = args;

    const caller = aws.getCallerIdentityOutput({}, { parent: this });

    // Tagged rather than granted by fixed ARN below (see CryptoShredArchiveKeysOnly):
    // the backend shreds the per-item item.kmsKeyId (disposal.ts), so the grant has to
    // follow whichever keys carry this tag, not two ARNs pinned at synth time. Any
    // future per-department/per-record archive CMK a later archive-writer Lambda
    // creates is covered by this grant as long as it carries the same tag — no
    // companion infra change needed when that writer lands.
    const CRYPTO_SHRED_TAG_KEY = "boxalarm:crypto-shred";
    const CRYPTO_SHRED_TAG_VALUE = "true";
    const ENV_TAG_KEY = "boxalarm:env";
    const cryptoShredTags = { [CRYPTO_SHRED_TAG_KEY]: CRYPTO_SHRED_TAG_VALUE, [ENV_TAG_KEY]: env };

    this.archivedIncidentCmk = new aws.kms.Key(
      `${name}-archived-incident-cmk`,
      {
        description: `Crypto-shred CMK for boxalarm-${env} archived incident records`,
        enableKeyRotation: true,
        policy: caller.accountId.apply(dynamodbCmkPolicy),
        tags: cryptoShredTags,
      },
      { parent: this },
    );

    this.archivedDeliveryReceiptCmk = new aws.kms.Key(
      `${name}-archived-delivery-receipt-cmk`,
      {
        description: `Crypto-shred CMK for boxalarm-${env} archived delivery receipts`,
        enableKeyRotation: true,
        policy: caller.accountId.apply(dynamodbCmkPolicy),
        tags: cryptoShredTags,
      },
      { parent: this },
    );

    this.disposalLambda = new ServiceLambda(
      `${name}-disposal`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-retention-disposal`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "retention-disposal"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          // Granted verifiedpermissions:IsAuthorizedWithToken below — without this,
          // readAuthzConfig() throws on every withAuthorization() call (including the
          // disposal route itself, disposalHandler.ts:144).
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // GetItem: runDisposal does a consistent GetItem per candidate before
              // deleting/shredding it (disposal.ts) — without it every candidate was
              // refused and disposal did nothing. PutItem: writeDisposalAudit appends
              // disposal's own AUDIT_LOG_ENTRY row (disposal.ts) — it was previously
              // ungranted AND explicitly denied by auditMutationDenyStatement below,
              // so even if GetItem were added, every run would destroy records with
              // no audit trail. BatchWriteItem is dropped: the code never calls it.
              Sid: "DisposalLobClassAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:Query",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:DeleteItem",
              ],
              Resource: tableArn,
            },
            // No incident-table delete grant, and no alerting-table grant at
            // all (DELIVERY_RECEIPT/DISPATCH_ALERT stay unreachable) — the
            // absence of those statements is the enforcement. PutItem above is no
            // longer blocked by this deny for the AUDIT_LOG_ENTRY insert — see
            // auditMutationDenyStatement's doc comment in data/platform-table.ts.
            auditMutationDenyStatement(tableArn),
            {
              // Scoped by tag, not two fixed ARNs: the backend shreds the per-item
              // item.kmsKeyId (disposal.ts), which may not be either of the two CMKs
              // this component provisions once a future archive-writer starts minting
              // per-department/per-record keys. Tag-scoping means this grant covers
              // any key so tagged without a companion infra change.
              Sid: "CryptoShredArchiveKeysOnly" as const,
              Effect: "Allow" as const,
              Action: ["kms:ScheduleKeyDeletion"],
              Resource: "*",
              Condition: {
                StringEquals: {
                  [`aws:ResourceTag/${CRYPTO_SHRED_TAG_KEY}`]: [CRYPTO_SHRED_TAG_VALUE],
                  [`aws:ResourceTag/${ENV_TAG_KEY}`]: [env],
                },
              },
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

    // retention/configHandler.ts: GET reads the RETENTION config item (GetItem);
    // putRetentionConfig re-reads it for the version, then does a conditional PutItem.
    this.configLambda = new ServiceLambda(
      `${name}-config`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-retention-config`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "retention-config"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              Sid: "RetentionConfigAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    // configHandler.ts dispatches on event.routeKey, so these must match it exactly.
    for (const method of ["GET", "PUT"] as const) {
      args.httpApi.route(
        `${name}-config-${method.toLowerCase()}-route`,
        { routeKey: `${method} /api/v1/platform/retention`, lambda: this.configLambda },
        { parent: this },
      );
    }

    this.invokedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-invoked-alarm`,
      {
        name: `boxalarm-${env}-platform-retention-disposal-invoked`,
        namespace: "Boxalarm/platform",
        metricName: "DisposalInvoked",
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

    // discoveryHandler.ts: a single ScanCommand pass (paginated) plus one GetItem per
    // distinct department for its retention config — read-only, nothing that mutates
    // the table. No alerting-table grant (this never touches alerting data at all),
    // and no CMK grant (it never schedules a key deletion — only disposalLambda does).
    this.discoveryLambda = new ServiceLambda(
      `${name}-discovery`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-retention-disposal-discovery`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "retention-disposal-discovery"),
        logGroup: args.logGroup,
        timeout: 60,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((tableArn) => [
          {
            Sid: "DisposalDiscoveryReadOnly" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:Scan", "dynamodb:GetItem"],
            Resource: [tableArn],
          },
        ]),
      },
      { parent: this },
    );

    const discoverySchedulerRole = new aws.iam.Role(
      `${name}-discovery-scheduler-role`,
      {
        name: `boxalarm-${env}-platform-retention-discovery-scheduler`,
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
      `${name}-discovery-scheduler-invoke-policy`,
      {
        role: discoverySchedulerRole.id,
        policy: this.discoveryLambda.function.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeDisposalDiscoveryLambda",
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

    const discoveryDeadLetter = new ScheduleDeadLetter(
      `${name}-discovery-schedule-dead-letter`,
      {
        queueName: `boxalarm-${env}-platform-retention-discovery-scheduler-dlq`,
        schedulerRole: discoverySchedulerRole,
        alarmActions: [args.chiefNotificationTopicArn],
      },
      { parent: this },
    );

    this.discoverySchedule = new aws.scheduler.Schedule(
      `${name}-discovery-schedule`,
      {
        name: `boxalarm-${env}-platform-retention-disposal-discovery`,
        scheduleExpression: "rate(1 day)",
        state: args.discoveryEnabled === false ? "DISABLED" : "ENABLED",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.discoveryLambda.function.arn,
          roleArn: discoverySchedulerRole.arn,
          ...discoveryDeadLetter.targetConfig,
        },
      },
      { parent: this },
    );

    this.candidatesFoundAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-candidates-found-alarm`,
      {
        name: `boxalarm-${env}-platform-retention-disposal-candidates-found`,
        alarmDescription:
          "The daily disposal candidate-discovery sweep found at least one record past " +
          "its department's configured retention window. Nothing was deleted or " +
          "shredded — review the Lambda's logs for the locator list, then POST the " +
          "ones to act on to POST /platform/retention/disposal.",
        namespace: "Boxalarm/platform",
        metricName: "DisposalCandidatesFound",
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

    this.discoveryErrorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-discovery-errors-alarm`,
      {
        name: `boxalarm-${env}-platform-retention-disposal-discovery-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.discoveryLambda.function.name },
        statistic: "Sum",
        period: 300,
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
      configLambda: this.configLambda,
      discoveryLambda: this.discoveryLambda,
      discoverySchedule: this.discoverySchedule,
      archivedIncidentCmk: this.archivedIncidentCmk,
      archivedDeliveryReceiptCmk: this.archivedDeliveryReceiptCmk,
    });
  }
}
