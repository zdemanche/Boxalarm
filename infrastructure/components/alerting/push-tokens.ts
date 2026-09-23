import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { HttpApi } from "../api/http-api";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { httpStubCode, asyncStubCode } from "./stub-code";
import { AlertingRoute } from "./route-lambda";
import { policyStore } from "../authz/policy-store";
import { platformBus } from "../messaging/platform-bus";

export interface PushTokensArgs {
  env: string;
  httpApi: HttpApi;
  platformTableArn: pulumi.Input<string>;
  platformTableName: pulumi.Input<string>;
  alertingTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  personnelLogGroup: ServiceLogGroup;
  alertingLogGroup: ServiceLogGroup;
  alertingPermissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Register/rotate device push tokens (E1-S14-INFRA): the personnel-service routes
 * (platform table only) and the alerting-plane `personnel.member.updated` consumer that
 * merges token changes into the eligibility snapshot (alerting table only — never reads
 * the platform table, preserving the isolation boundary).
 */
export class PushTokens extends pulumi.ComponentResource {
  public readonly registerRoute: AlertingRoute;
  public readonly revokeRoute: AlertingRoute;
  public readonly memberUpdatedConsumer: ServiceLambda;
  public readonly memberUpdatedQueue: aws.sqs.Queue;
  public readonly memberUpdatedDlq: aws.sqs.Queue;

  constructor(name: string, args: PushTokensArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PushTokens", args.env);
    super("boxalarm:alerting:PushTokens", name, {}, opts);
    const { env } = args;

    const personnelTableStatements: IamPolicyStatement[] = [
      {
        Sid: "PlatformTableReadWrite",
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:TransactWriteItems"],
        Resource: args.platformTableArn as string,
      },
      {
        Sid: "VerifiedPermissionsIsAuthorized",
        Effect: "Allow",
        Action: ["verifiedpermissions:IsAuthorizedWithToken"],
        Resource: "*",
      },
    ];
    const personnelEnv = {
      PERSONNEL_TABLE_NAME: args.platformTableName,
      PLATFORM_TABLE_NAME: args.platformTableName,
      PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
    };

    // src/services/personnel-service/pushTokens/registerToken.handler
    this.registerRoute = new AlertingRoute(
      `${name}-register`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.personnelLogGroup,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-push-tokens-register`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "POST /api/v1/personnel/members/{memberId}/push-tokens",
        environment: personnelEnv,
        additionalPolicyStatements: personnelTableStatements,
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    // src/services/personnel-service/pushTokens/revokeToken.handler
    this.revokeRoute = new AlertingRoute(
      `${name}-revoke`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.personnelLogGroup,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-push-tokens-revoke`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "DELETE /api/v1/personnel/members/{memberId}/push-tokens",
        environment: personnelEnv,
        additionalPolicyStatements: personnelTableStatements,
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    this.memberUpdatedDlq = new aws.sqs.Queue(
      `${name}-member-updated-dlq`,
      { name: `boxalarm-${env}-alerting-member-updated-dlq` },
      { parent: this },
    );
    this.memberUpdatedQueue = new aws.sqs.Queue(
      `${name}-member-updated-queue`,
      {
        name: `boxalarm-${env}-alerting-member-updated-queue`,
        visibilityTimeoutSeconds: 30,
        redrivePolicy: this.memberUpdatedDlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
        ),
      },
      { parent: this },
    );

    const rule = new aws.cloudwatch.EventRule(
      `${name}-member-updated-rule`,
      {
        name: `boxalarm-${env}-alerting-member-updated`,
        eventBusName: platformBus.busName,
        eventPattern: JSON.stringify({ "detail-type": ["personnel.member.updated"] }),
      },
      { parent: this },
    );

    new aws.sqs.QueuePolicy(
      `${name}-member-updated-queue-policy`,
      {
        queueUrl: this.memberUpdatedQueue.url,
        policy: pulumi.all([this.memberUpdatedQueue.arn, rule.arn]).apply(([queueArn, ruleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowMemberUpdatedRuleOnly",
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

    new aws.cloudwatch.EventTarget(
      `${name}-member-updated-target`,
      { rule: rule.name, eventBusName: platformBus.busName, arn: this.memberUpdatedQueue.arn },
      { parent: this },
    );

    // src/services/alerting-service/eligibility/memberUpdatedHandler.handler
    this.memberUpdatedConsumer = new ServiceLambda(
      `${name}-member-updated-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-member-updated-consumer`,
        handler: "index.handler",
        code: asyncStubCode(),
        logGroup: args.alertingLogGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableWrite",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: args.alertingTableArn as string,
          },
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.alertingPermissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.lambda.EventSourceMapping(
      `${name}-member-updated-event-source`,
      {
        eventSourceArn: this.memberUpdatedQueue.arn,
        functionName: this.memberUpdatedConsumer.function.name,
        functionResponseTypes: ["ReportBatchItemFailures"],
      },
      { parent: this },
    );

    this.registerOutputs({
      registerRoute: this.registerRoute,
      revokeRoute: this.revokeRoute,
      memberUpdatedConsumer: this.memberUpdatedConsumer,
    });
  }
}
