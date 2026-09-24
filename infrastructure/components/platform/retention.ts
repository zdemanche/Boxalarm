import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { dynamodbCmkPolicy } from "../data/cmk-policy";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
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

    // The daily schedule invokes the disposal Lambda directly (target.arn above, not
    // an HTTP-shaped call) — but disposalHandler.ts's handler is written only for
    // API-Gateway-shaped requests: it requires a bearer token and checks
    // event.routeKey, so a raw Scheduler invocation gets a 401/404 and disposes
    // nothing. Giving disposalHandler.ts a non-HTTP scheduled entry point is a
    // backend change outside this infra-only PR's footprint. What IS fixable here:
    // watching AWS/Lambda Invocations meant this alarm fired on every scheduled
    // attempt regardless of whether disposal logic ever ran, paging the chief daily
    // and burying real manual disposals in the noise. Watching the backend's own
    // DisposalInvoked metric instead (disposal.ts's emitDisposalInvoked(), which
    // only fires from inside runDisposal's finally block — i.e. only when the
    // business logic actually executes, not on a failed-auth/404 request) means the
    // alarm goes quiet on today's non-functional scheduled runs instead of paging
    // on them, while still firing correctly for every real disposal a chief runs
    // manually. See export.ts/recovery-monitor.ts for the same
    // watch-what-the-backend-actually-emits fix applied to their alarms.
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

    this.registerOutputs({
      disposalLambda: this.disposalLambda,
      archivedIncidentCmk: this.archivedIncidentCmk,
      archivedDeliveryReceiptCmk: this.archivedDeliveryReceiptCmk,
    });
  }
}
