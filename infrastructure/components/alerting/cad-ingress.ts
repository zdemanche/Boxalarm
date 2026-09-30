import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { RuleDeliveryGuard } from "../messaging/rule-delivery";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";

/**
 * CAD dispatch ingress (docs/decisions/2026-09-29-roadmap-defaults.md row 3,
 * 2026-09-29-cad-ingress-auth.md): two deterministic, authenticated paths into the SAME
 * DISPATCH_ALERT write the manual route makes, so the table stream's fan-out stays the single
 * tone-1 producer.
 *
 *  - Source config: platform.config.updated (configType CAD_INGRESS) -> SQS + DLQ ->
 *    cadIngress/sourceCopyHandler.ts -> CAD_INGRESS_COPY. Same shape as AlertRulesCopy.
 *  - Signed webhook: its OWN REST API (security review M4). No Cognito authorizer exists on
 *    it, so it shares neither authorizer nor capacity with the main HTTP API. Every source has
 *    its own API key in a usage plan with a per-key throttle: API Gateway answers 403 to a
 *    request without a valid key BEFORE any per-source bucket or the Lambda, so an
 *    unauthenticated flood cannot starve a genuine CAD (only the account-level limit is
 *    shared), and a flood with one source's key throttles only that source. An optional
 *    stack-wide source-IP allowlist is enforced in the API's resource policy. HMAC is still
 *    the authentication; the API key is a capacity partition, not a credential.
 *  - SES inbound email (only when `cadIngressEmailDomain` is set): receipt rule set -> the
 *    encrypted mail bucket (S3 action) -> the email Lambda (async). SES receiving exists in
 *    us-east-1, where every stack is pinned.
 *
 * Every Lambda here is an alerting-service Lambda under the alerting permissions boundary:
 * it can never read the platform or incident table. Every alarm goes to the ops page topic
 * (alerting-page), never to the crew's FIFO delivery topic; authentication failures and
 * quarantined mail also notify the chief (the decision record's "chief and platform
 * operator").
 */

export const CAD_WEBHOOK_PATH = "api/v1/alerting/ingress/cad-webhook";
export const CAD_WEBHOOK_STAGE = "cad";
/**
 * Per source (per API key). A CAD sends a handful of dispatches an hour, and a mass-casualty
 * burst is tens; this is a flood cap on one source's key, never shared with another source.
 */
export const CAD_WEBHOOK_KEY_THROTTLE = { rateLimit: 5, burstLimit: 20 } as const;
export const CAD_METRIC_NAMESPACE = "Boxalarm/alerting-cad-ingress";
/** Where SES writes each raw message, keyed by its SES message id (emailHandler.ts). */
export const CAD_MAIL_PREFIX = "inbound/";
/** Failed (quarantined) and processed mail alike is kept this long, then expires. */
export const CAD_MAIL_RETENTION_DAYS = 30;
const WEBHOOK_RESERVED_CONCURRENCY = 5;
const EMAIL_RESERVED_CONCURRENCY = 5;
const COPY_RESERVED_CONCURRENCY = 2;
const COPY_TIMEOUT_SECONDS = 15;

export interface CadIngressArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  /** The alerting SNS FIFO topic: the update notifier publishes UPDATE pushes (push only). */
  alertingTopicArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  /** alerting-page: every alarm here. */
  pageTopicArn: pulumi.Input<string>;
  /** chief-notifications: authentication failures, quarantine and RAW fallbacks too. */
  opsTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn: pulumi.Input<string>;
  /** The inbound mail domain (MX -> SES). Unset: no email path is created. */
  emailDomain?: string;
  /**
   * Optional source-IP allowlist (CIDRs) for the webhook, enforced by the REST API's resource
   * policy before anything else runs. Dispatch centres usually have static egress.
   */
  webhookAllowedCidrs?: readonly string[];
}

/**
 * The webhook secret names the rotation route creates: `{prefix}{deptId}/{sourceId}`. '/' is in
 * neither id, so names cannot collide across departments (security review M1).
 */
export function cadWebhookSecretPrefix(env: string): string {
  return `boxalarm-${env}-cad-webhook/`;
}

/**
 * The alerting-table grants both ingress Lambdas need, each scoped by partition:
 * read the source copy, claim/release replay markers, and write the dispatch transaction
 * (idempotency lock, DISPATCH_ALERT, bridge outbox row) exactly as createManualDispatch does.
 */
export function cadIngressTableStatements(tableArn: string): IamPolicyStatement[] {
  return [
    {
      Sid: "CadSourceCopyRead",
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: tableArn,
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CAD_INGRESS"] } },
    },
    {
      Sid: "CadReplayMarkers",
      Effect: "Allow",
      Action: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CAD_REPLAY#*"] },
      },
    },
    {
      // An incident's lock -> its dispatch, then the dispatch as stored, to record a CAD update
      // (cadIngress/updateRepository.ts).
      Sid: "CadUpdateRead",
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["DEPT#*#DISPATCH_IDEMPOTENCY#*", "DEPT#*#DISPATCH#*"],
        },
      },
    },
    {
      // One TransactWriteItems of conditional Puts (and, for an update, one conditional
      // Update of the DISPATCH_ALERT); DynamoDB authorizes each item as its own action.
      Sid: "CadDispatchWrite",
      Effect: "Allow",
      Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
      Resource: tableArn,
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "DEPT#*#DISPATCH_IDEMPOTENCY#*",
            "DEPT#*#DISPATCH#*",
            "DEPT#*#OUTBOX",
          ],
        },
      },
    },
  ];
}

export class CadIngress extends pulumi.ComponentResource {
  public readonly copyLambda: ServiceLambda;
  public readonly copyQueue: aws.sqs.Queue;
  public readonly copyDlq: aws.sqs.Queue;
  public readonly copyRule: aws.cloudwatch.EventRule;
  public readonly webhookApi: aws.apigateway.RestApi;
  public readonly webhookStage: aws.apigateway.Stage;
  public readonly webhookMethod: aws.apigateway.Method;
  /** Every source's API key is attached to this plan by the rotation route. */
  public readonly webhookUsagePlan: aws.apigateway.UsagePlan;
  public readonly webhookLambda: ServiceLambda;
  /** Full URL a CAD POSTs to. */
  public readonly webhookUrl: pulumi.Output<string>;
  public readonly emailLambda?: ServiceLambda;
  /** The non-escalating UPDATE push for a CAD update, async-invoked by the ingress Lambdas. */
  public readonly updateNotifierLambda: ServiceLambda;
  public readonly updateNotifierFailureQueue: aws.sqs.Queue;
  public readonly mailBucket?: aws.s3.BucketV2;
  public readonly mailKey?: aws.kms.Key;
  public readonly emailFailureQueue?: aws.sqs.Queue;
  public readonly receiptRuleSet?: aws.ses.ReceiptRuleSet;
  public readonly receiptRule?: aws.ses.ReceiptRule;
  public readonly alarms: aws.cloudwatch.MetricAlarm[] = [];
  private readonly baseName: string;

  constructor(name: string, args: CadIngressArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("CadIngress", args.env);
    super("boxalarm:alerting:CadIngress", name, {}, opts);
    this.baseName = name;
    const { env } = args;
    const tableArn = pulumi.output(args.alertingTableArn);
    const identity = aws.getCallerIdentityOutput({}, { parent: this });
    const region = aws.getRegionOutput({}, { parent: this });
    const secretArnPattern = pulumi.interpolate`arn:aws:secretsmanager:${region.name}:${identity.accountId}:secret:${cadWebhookSecretPrefix(env)}*`;

    // ---- Source config projection (platform.config.updated CAD_INGRESS -> CAD_INGRESS_COPY)
    this.copyDlq = new aws.sqs.Queue(
      `${name}-copy-dlq`,
      { name: `boxalarm-${env}-alerting-cad-source-copy-dlq`, messageRetentionSeconds: 1_209_600 },
      { parent: this },
    );
    this.copyQueue = new aws.sqs.Queue(
      `${name}-copy-queue`,
      {
        name: `boxalarm-${env}-alerting-cad-source-copy-queue`,
        visibilityTimeoutSeconds: COPY_TIMEOUT_SECONDS * 6,
        redrivePolicy: this.copyDlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
        ),
      },
      { parent: this },
    );
    // A routing filter, not a trust boundary (see alert-rules-copy.ts, review F3); the consumer
    // re-validates every source it writes.
    this.copyRule = new aws.cloudwatch.EventRule(
      `${name}-copy-rule`,
      {
        name: `boxalarm-${env}-alerting-cad-source-copy`,
        eventBusName: args.busName,
        eventPattern: JSON.stringify({
          source: ["platform-service"],
          "detail-type": ["platform.config.updated"],
          detail: { payload: { configType: ["CAD_INGRESS"] } },
        }),
      },
      { parent: this },
    );
    const copyQueuePolicy = new aws.sqs.QueuePolicy(
      `${name}-copy-queue-policy`,
      {
        queueUrl: this.copyQueue.url,
        policy: pulumi.all([this.copyQueue.arn, this.copyRule.arn]).apply(([queueArn, ruleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowCadSourceRuleOnly",
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: { ArnEquals: { "aws:SourceArn": ruleArn } },
              },
            ],
          }),
        ),
      },
      { parent: this },
    );
    const copyDelivery = new RuleDeliveryGuard(
      `${name}-copy-delivery`,
      {
        alarmName: `boxalarm-${env}-alerting-cad-source-copy-failed-invocations`,
        rule: this.copyRule,
        busName: args.busName,
        deadLetterQueue: this.copyDlq,
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );
    new aws.cloudwatch.EventTarget(
      `${name}-copy-target`,
      {
        rule: this.copyRule.name,
        eventBusName: args.busName,
        arn: this.copyQueue.arn,
        deadLetterConfig: { arn: this.copyDlq.arn },
      },
      { parent: this, dependsOn: [copyQueuePolicy, copyDelivery] },
    );
    this.copyLambda = new ServiceLambda(
      `${name}-copy-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-cad-source-copy-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "cad-source-copy-consumer"),
        logGroup: args.logGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        timeout: COPY_TIMEOUT_SECONDS,
        additionalPolicyStatements: tableArn.apply((arn) => [
          {
            Sid: "CadSourceCopyWrite",
            Effect: "Allow" as const,
            Action: ["dynamodb:PutItem"],
            Resource: arn,
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CAD_INGRESS"] },
            },
          },
        ]),
        // 2, and the mapping pinned to 2 (its minimum): see first-deploy m8 on alert-rules-copy.
        reservedConcurrentExecutions: COPY_RESERVED_CONCURRENCY,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );
    new aws.lambda.EventSourceMapping(
      `${name}-copy-event-source`,
      {
        eventSourceArn: this.copyQueue.arn,
        functionName: this.copyLambda.function.name,
        batchSize: 10,
        functionResponseTypes: ["ReportBatchItemFailures"],
        scalingConfig: { maximumConcurrency: COPY_RESERVED_CONCURRENCY },
      },
      { parent: this },
    );
    new aws.iam.RolePolicy(
      `${name}-copy-consume-policy`,
      {
        role: this.copyLambda.role.id,
        policy: this.copyQueue.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ConsumeCadSourceQueue",
                Effect: "Allow",
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    // ---- CAD update notifier (docs/decisions/2026-09-30-cad-dispatch-updates.md). Invoked
    // asynchronously by the ingress Lambdas after an update is durably recorded - NOT from the
    // table stream, which already has its two readers (fan-out, outbox drain): a third reader
    // per shard is throttled and would slow the tone-1 fan-out.
    this.updateNotifierFailureQueue = new aws.sqs.Queue(
      `${name}-update-notifier-failures`,
      {
        name: `boxalarm-${env}-alerting-cad-update-notifier-failures`,
        messageRetentionSeconds: 1_209_600,
      },
      { parent: this },
    );
    this.updateNotifierLambda = new ServiceLambda(
      `${name}-update-notifier-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-cad-update-notifier`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "cad-update-notifier"),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
        },
        additionalPolicyStatements: pulumi
          .all([tableArn, args.alertingTopicArn])
          .apply(([arn, topicArn]): IamPolicyStatement[] => [
            {
              // The update, the dispatch, its roster, and the per-member CADUPDATE# claims -
              // all on the dispatch's own partition.
              Sid: "CadUpdateNotifierDispatchPartition",
              Effect: "Allow",
              Action: [
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
              ],
              Resource: arn,
              Condition: {
                "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#DISPATCH#*"] },
              },
            },
            {
              Sid: "AlertingTopicPublish",
              Effect: "Allow",
              Action: ["sns:Publish"],
              Resource: topicArn,
            },
          ]),
        reservedConcurrentExecutions: 2,
        timeout: 30,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );
    new aws.iam.RolePolicy(
      `${name}-update-notifier-on-failure`,
      {
        role: this.updateNotifierLambda.role.id,
        policy: this.updateNotifierFailureQueue.arn.apply((queueArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "CadUpdateNotifierOnFailure",
                Effect: "Allow",
                Action: "sqs:SendMessage",
                Resource: queueArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );
    new aws.lambda.FunctionEventInvokeConfig(
      `${name}-update-notifier-invoke-config`,
      {
        functionName: this.updateNotifierLambda.function.name,
        maximumRetryAttempts: 2,
        // An update push later than this is stale news; the update still shows on the call.
        maximumEventAgeInSeconds: 900,
        destinationConfig: { onFailure: { destination: this.updateNotifierFailureQueue.arn } },
      },
      { parent: this },
    );
    const invokeNotifier = this.updateNotifierLambda.function.arn.apply(
      (fnArn): IamPolicyStatement => ({
        Sid: "InvokeCadUpdateNotifier",
        Effect: "Allow",
        Action: ["lambda:InvokeFunction"],
        Resource: fnArn,
      }),
    );

    // ---- Signed webhook: its own API, stage, throttle and reserved concurrency.
    this.webhookLambda = new ServiceLambda(
      `${name}-webhook-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-cad-webhook`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "cad-webhook"),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          CAD_UPDATE_NOTIFIER_FUNCTION: this.updateNotifierLambda.function.name,
          // The webhook refuses a source whose secret is not exactly {prefix}{dept}/{source}.
          CAD_WEBHOOK_SECRET_PREFIX: cadWebhookSecretPrefix(env),
        },
        additionalPolicyStatements: pulumi
          .all([tableArn, secretArnPattern, invokeNotifier])
          .apply(([arn, secretArn, invoke]): IamPolicyStatement[] => [
            ...cadIngressTableStatements(arn),
            invoke,
            {
              // Read only, and only the CAD webhook secrets; the rotation route writes them.
              Sid: "CadWebhookKeysRead",
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: secretArn,
            },
          ]),
        reservedConcurrentExecutions: WEBHOOK_RESERVED_CONCURRENCY,
        // A source read, a secret read (cached), a replay put and one transaction.
        timeout: 10,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const cidrs = [...(args.webhookAllowedCidrs ?? [])];
    this.webhookApi = new aws.apigateway.RestApi(
      `${name}-webhook-api`,
      {
        name: `boxalarm-${env}-cad-ingress-api`,
        description:
          "CAD dispatch webhook only. Per-source API keys partition capacity; requests authenticate by HMAC in the Lambda.",
        endpointConfiguration: { types: "REGIONAL" },
        apiKeySource: "HEADER",
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Action: "execute-api:Invoke",
              Resource: "execute-api:/*",
            },
            ...(cidrs.length > 0
              ? [
                  {
                    Effect: "Deny",
                    Principal: "*",
                    Action: "execute-api:Invoke",
                    Resource: "execute-api:/*",
                    Condition: { NotIpAddress: { "aws:SourceIp": cidrs } },
                  },
                ]
              : []),
          ],
        }),
      },
      { parent: this },
    );
    let parentId: pulumi.Input<string> = this.webhookApi.rootResourceId;
    let resource: aws.apigateway.Resource | undefined;
    for (const part of CAD_WEBHOOK_PATH.split("/")) {
      resource = new aws.apigateway.Resource(
        `${name}-webhook-resource-${part}`,
        { restApi: this.webhookApi.id, parentId, pathPart: part },
        { parent: this },
      );
      parentId = resource.id;
    }
    const leaf = resource!;
    this.webhookMethod = new aws.apigateway.Method(
      `${name}-webhook-method`,
      {
        restApi: this.webhookApi.id,
        resourceId: leaf.id,
        httpMethod: "POST",
        authorization: "NONE",
        apiKeyRequired: true,
      },
      { parent: this },
    );
    const integration = new aws.apigateway.Integration(
      `${name}-webhook-integration`,
      {
        restApi: this.webhookApi.id,
        resourceId: leaf.id,
        httpMethod: this.webhookMethod.httpMethod,
        type: "AWS_PROXY",
        integrationHttpMethod: "POST",
        uri: this.webhookLambda.function.invokeArn,
        timeoutMilliseconds: 10_000,
      },
      { parent: this },
    );
    new aws.lambda.Permission(
      `${name}-webhook-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: this.webhookLambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.webhookApi.executionArn}/*/POST/${CAD_WEBHOOK_PATH}`,
      },
      { parent: this },
    );
    const deployment = new aws.apigateway.Deployment(
      `${name}-webhook-deployment`,
      {
        restApi: this.webhookApi.id,
        triggers: {
          redeployment: pulumi
            .all([this.webhookMethod.id, integration.id, this.webhookApi.policy])
            .apply((parts) => JSON.stringify(parts)),
        },
      },
      { parent: this, dependsOn: [this.webhookMethod, integration] },
    );
    this.webhookStage = new aws.apigateway.Stage(
      `${name}-webhook-stage`,
      {
        restApi: this.webhookApi.id,
        deployment: deployment.id,
        stageName: CAD_WEBHOOK_STAGE,
      },
      { parent: this },
    );
    // No stage-wide method throttle: that would be ONE bucket every caller shares (the flaw
    // the review found). Capacity is per key, in the usage plan.
    new aws.apigateway.MethodSettings(
      `${name}-webhook-method-settings`,
      {
        restApi: this.webhookApi.id,
        stageName: this.webhookStage.stageName,
        methodPath: "*/*",
        settings: { metricsEnabled: true },
      },
      { parent: this },
    );
    this.webhookUsagePlan = new aws.apigateway.UsagePlan(
      `${name}-webhook-usage-plan`,
      {
        name: `boxalarm-${env}-cad-webhook`,
        description: "One API key per CAD source; each key gets its own throttle bucket.",
        apiStages: [{ apiId: this.webhookApi.id, stage: this.webhookStage.stageName }],
        throttleSettings: {
          rateLimit: CAD_WEBHOOK_KEY_THROTTLE.rateLimit,
          burstLimit: CAD_WEBHOOK_KEY_THROTTLE.burstLimit,
        },
      },
      { parent: this },
    );
    this.webhookUrl = pulumi.interpolate`${this.webhookStage.invokeUrl}/${CAD_WEBHOOK_PATH}`;

    const lambdaRoles: Record<string, aws.iam.Role> = {
      copy: this.copyLambda.role,
      updateNotifier: this.updateNotifierLambda.role,
      webhook: this.webhookLambda.role,
    };

    // ---- SES inbound email (optional until the department's mail domain exists).
    if (args.emailDomain !== undefined) {
      const domain = args.emailDomain.toLowerCase();
      const ruleSetName = `boxalarm-${env}-cad-ingress`;
      const receiptRuleArn = pulumi.interpolate`arn:aws:ses:${region.name}:${identity.accountId}:receipt-rule-set/${ruleSetName}:receipt-rule/*`;

      this.mailKey = new aws.kms.Key(
        `${name}-mail-key`,
        {
          description: `boxalarm-${env} CAD inbound mail (SES -> S3, SSE-KMS)`,
          enableKeyRotation: true,
          deletionWindowInDays: 30,
          policy: pulumi.all([identity.accountId, receiptRuleArn]).apply(([account, ruleArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "AccountAdministersKeyViaIam",
                  Effect: "Allow",
                  Principal: { AWS: `arn:aws:iam::${account}:root` },
                  Action: "kms:*",
                  Resource: "*",
                },
                {
                  // SES writes each message with the bucket's default SSE-KMS encryption.
                  Sid: "SesEncryptsInboundMail",
                  Effect: "Allow",
                  Principal: { Service: "ses.amazonaws.com" },
                  Action: ["kms:GenerateDataKey*", "kms:Encrypt"],
                  Resource: "*",
                  Condition: {
                    StringEquals: { "aws:SourceAccount": account },
                    ArnLike: { "aws:SourceArn": ruleArn },
                  },
                },
              ],
            }),
          ),
        },
        { parent: this },
      );
      new aws.kms.Alias(
        `${name}-mail-key-alias`,
        { name: `alias/boxalarm-${env}-cad-mail`, targetKeyId: this.mailKey.keyId },
        { parent: this },
      );

      this.mailBucket = new aws.s3.BucketV2(
        `${name}-mail-bucket`,
        {
          bucket: pulumi.interpolate`boxalarm-${env}-cad-mail-${identity.accountId}`,
          forceDestroy: env === "dev",
        },
        { parent: this },
      );
      const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
        `${name}-mail-bucket-pab`,
        {
          bucket: this.mailBucket.id,
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        },
        { parent: this },
      );
      const encryption = new aws.s3.BucketServerSideEncryptionConfigurationV2(
        `${name}-mail-bucket-sse`,
        {
          bucket: this.mailBucket.id,
          rules: [
            {
              applyServerSideEncryptionByDefault: {
                sseAlgorithm: "aws:kms",
                kmsMasterKeyId: this.mailKey.arn,
              },
              bucketKeyEnabled: true,
            },
          ],
        },
        { parent: this },
      );
      new aws.s3.BucketLifecycleConfigurationV2(
        `${name}-mail-bucket-lifecycle`,
        {
          bucket: this.mailBucket.id,
          rules: [
            {
              id: "expire-inbound-mail",
              status: "Enabled",
              filter: { prefix: CAD_MAIL_PREFIX },
              expiration: { days: CAD_MAIL_RETENTION_DAYS },
            },
          ],
        },
        { parent: this },
      );
      const bucketPolicy = new aws.s3.BucketPolicy(
        `${name}-mail-bucket-policy`,
        {
          bucket: this.mailBucket.id,
          policy: pulumi
            .all([this.mailBucket.arn, identity.accountId, receiptRuleArn])
            .apply(([bucketArn, account, ruleArn]) =>
              JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "SesWritesInboundMailOnly",
                    Effect: "Allow",
                    Principal: { Service: "ses.amazonaws.com" },
                    Action: "s3:PutObject",
                    Resource: `${bucketArn}/${CAD_MAIL_PREFIX}*`,
                    Condition: {
                      StringEquals: { "aws:SourceAccount": account },
                      ArnLike: { "aws:SourceArn": ruleArn },
                    },
                  },
                  {
                    Sid: "DenyInsecureTransport",
                    Effect: "Deny",
                    Principal: "*",
                    Action: "s3:*",
                    Resource: [bucketArn, `${bucketArn}/*`],
                    Condition: { Bool: { "aws:SecureTransport": "false" } },
                  },
                ],
              }),
            ),
        },
        { parent: this, dependsOn: [publicAccessBlock] },
      );

      this.emailFailureQueue = new aws.sqs.Queue(
        `${name}-email-failures`,
        {
          name: `boxalarm-${env}-alerting-cad-email-failures`,
          messageRetentionSeconds: 1_209_600,
        },
        { parent: this },
      );

      this.emailLambda = new ServiceLambda(
        `${name}-email-fn`,
        {
          env,
          serviceName: "alerting-service",
          functionName: `boxalarm-${env}-alerting-cad-email`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("alerting-service", "cad-email"),
          logGroup: args.logGroup,
          environment: {
            ALERTING_TABLE_NAME: args.alertingTableName,
            CAD_MAIL_BUCKET: this.mailBucket.bucket,
            CAD_MAIL_PREFIX,
            CAD_INGRESS_EMAIL_DOMAIN: domain,
            CAD_UPDATE_NOTIFIER_FUNCTION: this.updateNotifierLambda.function.name,
          },
          additionalPolicyStatements: pulumi
            .all([tableArn, this.mailBucket.arn, this.mailKey.arn, invokeNotifier])
            .apply(([arn, bucketArn, keyArn, invoke]): IamPolicyStatement[] => [
              ...cadIngressTableStatements(arn),
              invoke,
              {
                Sid: "ReadInboundMail",
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: `${bucketArn}/${CAD_MAIL_PREFIX}*`,
              },
              {
                Sid: "DecryptInboundMail",
                Effect: "Allow",
                Action: ["kms:Decrypt"],
                Resource: keyArn,
              },
            ]),
          reservedConcurrentExecutions: EMAIL_RESERVED_CONCURRENCY,
          timeout: 30,
          memorySize: 512,
          permissionsBoundaryArn: args.permissionsBoundaryArn,
        },
        { parent: this },
      );
      new aws.iam.RolePolicy(
        `${name}-email-on-failure`,
        {
          role: this.emailLambda.role.id,
          policy: this.emailFailureQueue.arn.apply((queueArn) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "CadEmailOnFailure",
                  Effect: "Allow",
                  Action: "sqs:SendMessage",
                  Resource: queueArn,
                },
              ],
            }),
          ),
        },
        { parent: this },
      );
      // Two retries for a dependency blip; an event older than the 10-minute freshness rule
      // could not pass it anyway, so it goes to the alarmed failure queue instead.
      new aws.lambda.FunctionEventInvokeConfig(
        `${name}-email-invoke-config`,
        {
          functionName: this.emailLambda.function.name,
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 600,
          destinationConfig: { onFailure: { destination: this.emailFailureQueue.arn } },
        },
        { parent: this },
      );
      const sesInvoke = new aws.lambda.Permission(
        `${name}-email-ses-invoke`,
        {
          action: "lambda:InvokeFunction",
          function: this.emailLambda.function.name,
          principal: "ses.amazonaws.com",
          sourceAccount: identity.accountId,
          sourceArn: receiptRuleArn,
        },
        { parent: this },
      );

      // One active receipt rule set per account and region: another reason each stack gets its
      // own account (docs/runbooks/first-deploy.md, "Account strategy").
      this.receiptRuleSet = new aws.ses.ReceiptRuleSet(
        `${name}-rule-set`,
        { ruleSetName },
        { parent: this },
      );
      this.receiptRule = new aws.ses.ReceiptRule(
        `${name}-rule`,
        {
          name: `boxalarm-${env}-cad-dispatch`,
          ruleSetName: this.receiptRuleSet.ruleSetName,
          recipients: [domain],
          enabled: true,
          // Spam and virus verdicts: the email Lambda refuses a FAIL on either.
          scanEnabled: true,
          tlsPolicy: "Require",
          s3Actions: [
            {
              bucketName: this.mailBucket.bucket,
              objectKeyPrefix: CAD_MAIL_PREFIX,
              position: 1,
            },
          ],
          lambdaActions: [
            { functionArn: this.emailLambda.function.arn, invocationType: "Event", position: 2 },
          ],
        },
        { parent: this, dependsOn: [bucketPolicy, encryption, sesInvoke] },
      );
      new aws.ses.ActiveReceiptRuleSet(
        `${name}-active-rule-set`,
        { ruleSetName: this.receiptRuleSet.ruleSetName },
        { parent: this, dependsOn: [this.receiptRule] },
      );
      lambdaRoles.email = this.emailLambda.role;

      this.alarms.push(
        this.alarm("email-failures", {
          name: `boxalarm-${env}-alerting-cad-email-failures-not-empty`,
          description:
            "A CAD dispatch email could not be processed after retries (mail bucket, DynamoDB or the Lambda failed). It did NOT page: check the failure queue and the mail bucket, fix, and tone the call out by radio if it is live.",
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensions: { QueueName: this.emailFailureQueue.name },
          statistic: "Maximum",
          actions: [args.pageTopicArn],
        }),
      );
    }

    grantAlertingCmk(name, lambdaRoles, args.alertingCmkArn, { parent: this });

    // ---- Alarms: the ops page topic, never the crew's delivery topic.
    const cadAlarm = (
      suffix: string,
      metricName: string,
      description: string,
      actions: pulumi.Input<string>[],
      threshold = 0,
      period = 60,
    ) =>
      this.alarm(suffix, {
        name: `boxalarm-${env}-alerting-cad-${suffix}`,
        description,
        namespace: CAD_METRIC_NAMESPACE,
        metricName,
        statistic: "Sum",
        threshold,
        period,
        actions,
      });
    this.alarms.push(
      cadAlarm(
        "auth-failed",
        "CadIngressAuthFailed",
        "CAD ingress refused messages that failed authentication (bad signature, stale timestamp, unknown source, SPF/DKIM/DMARC, sender not allowlisted). They did NOT page. Either a forgery attempt or a genuine CAD source that is misconfigured - if genuine, dispatches are not reaching the app: radio tone-out (N1.9) is the page of record until fixed.",
        [args.pageTopicArn, args.opsTopicArn],
        2,
        300,
      ),
      cadAlarm(
        "replay-rejected",
        "CadIngressReplayRejected",
        "A CAD message identical to one already WRITTEN was refused (same webhook signature, or same email Message-ID and DKIM signature). The marker commits in the same transaction as the dispatch, so the original did page; this is a sender retry of identical bytes or a replay attempt. Several in a row from an unknown sender: treat as an attack.",
        [args.pageTopicArn],
      ),
      cadAlarm(
        "quarantined",
        "CadIngressQuarantined",
        "A CAD email failed authentication and was kept in the mail bucket (inbound/<SES message id>) for review. It did NOT page.",
        [args.pageTopicArn, args.opsTopicArn],
      ),
      cadAlarm(
        "duplicate",
        "CadIngressDuplicate",
        "A CAD message was treated as a duplicate of one already paged and did NOT page (same incident number, or identical text within 10 minutes for a source with no incident number rule). Usually a CAD resend. If a crew reports a missed call, check the source's template reads the incident number (Settings > CAD sources).",
        [args.pageTopicArn],
      ),
      cadAlarm(
        "rejected",
        "CadIngressRejected",
        "CAD ingress could not process a message (a dependency was unavailable, or a webhook body was too large). It did NOT page; the sender retries a webhook, Lambda retries an email.",
        [args.pageTopicArn],
      ),
      cadAlarm(
        "raw-fallback",
        "CadIngressRawFallback",
        "A CAD dispatch paged as raw text (SEE DISPATCH TEXT, flagged VERIFY): the source's parser template did not find the address. The page went; fix the template (Settings > CAD sources > test parse).",
        [args.pageTopicArn, args.opsTopicArn],
      ),
      cadAlarm(
        "update-push-failed",
        "CadUpdatePushFailed",
        "A CAD update to a call was recorded (it shows on the call) but its UPDATE push to the crew failed or could not be handed off. Crews already paged did not get the change on their phones: relay it by radio if it matters.",
        [args.pageTopicArn],
      ),
      this.alarm("update-notifier-failures", {
        name: `boxalarm-${env}-alerting-cad-update-notifier-failures-not-empty`,
        description:
          "The CAD update notifier failed after retries: an UPDATE push did not reach the crew. The update is recorded on the call; relay it by radio if it matters, then check the notifier logs.",
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.updateNotifierFailureQueue.name },
        statistic: "Maximum",
        actions: [args.pageTopicArn],
      }),
      this.alarm("webhook-4xx", {
        name: `boxalarm-${env}-alerting-cad-webhook-4xx`,
        description:
          "Many CAD webhook requests were refused by API Gateway or the Lambda (403 no/invalid API key or IP not allowed, 429 a source over its throttle, 401 authentication). A flood against the webhook, or a CAD misconfigured after a key rotation. A genuine CAD being refused means dispatches are not reaching the app: radio tone-out is the page of record until fixed.",
        namespace: "AWS/ApiGateway",
        metricName: "4XXError",
        dimensions: { ApiName: this.webhookApi.name, Stage: this.webhookStage.stageName },
        statistic: "Sum",
        threshold: 20,
        period: 300,
        actions: [args.pageTopicArn, args.opsTopicArn],
      }),
      this.alarm("webhook-errors", {
        name: `boxalarm-${env}-alerting-cad-webhook-errors`,
        description:
          "The CAD webhook Lambda is erroring or being throttled: CAD dispatches may not be reaching the app.",
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.webhookLambda.function.name },
        statistic: "Sum",
        actions: [args.pageTopicArn],
      }),
      this.alarm("webhook-throttles", {
        name: `boxalarm-${env}-alerting-cad-webhook-throttles`,
        description:
          "The CAD webhook Lambda hit its reserved concurrency: dispatches are being refused (5xx). A flood with valid source keys, or a CAD retry storm.",
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        dimensions: { FunctionName: this.webhookLambda.function.name },
        statistic: "Sum",
        actions: [args.pageTopicArn],
      }),
      this.alarm("source-copy-dlq", {
        name: `boxalarm-${env}-alerting-cad-source-copy-dlq-not-empty`,
        description:
          "A CAD sources change could not be copied into the alerting table: ingress is running on the previous sources (new senders or keys are refused). Check the cad-source-copy consumer logs, fix, then redrive the DLQ.",
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.copyDlq.name },
        statistic: "Maximum",
        actions: [args.pageTopicArn],
      }),
    );

    this.registerOutputs({
      webhookUrl: this.webhookUrl,
      webhookUsagePlan: this.webhookUsagePlan,
      webhookLambda: this.webhookLambda,
      emailLambda: this.emailLambda,
    });
  }

  private alarm(
    suffix: string,
    spec: {
      name: string;
      description: string;
      namespace: string;
      metricName: string;
      statistic: string;
      actions: pulumi.Input<string>[];
      dimensions?: Record<string, pulumi.Input<string>>;
      threshold?: number;
      period?: number;
    },
  ): aws.cloudwatch.MetricAlarm {
    return new aws.cloudwatch.MetricAlarm(
      `${this.baseName}-${suffix}-alarm`,
      {
        name: spec.name,
        alarmDescription: spec.description,
        namespace: spec.namespace,
        metricName: spec.metricName,
        ...(spec.dimensions ? { dimensions: spec.dimensions } : {}),
        statistic: spec.statistic,
        period: spec.period ?? 60,
        evaluationPeriods: 1,
        threshold: spec.threshold ?? 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: spec.actions,
      },
      { parent: this },
    );
  }
}
