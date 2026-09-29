import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { IamPolicyStatement } from "../observability/observability-policy";
import { auditMutationDenyStatement } from "../data/platform-table";
import { nerisClientPolicyStatements } from "../neris/neris-config";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface NerisEntityArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  nerisCredentialsSecretArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * GET/PUT /api/v1/platform/neris/entity (platform-service/neris/{get,put}Entity.ts): the
 * department's stations and units registered with its NERIS entity. The PUT starts a sync
 * (202) and the sync worker makes the NERIS calls asynchronously, so only the worker reads
 * the OAuth secret; the GET is a single GetItem.
 */
export class NerisEntity extends pulumi.ComponentResource {
  public readonly getLambda: ServiceLambda;
  public readonly putLambda: ServiceLambda;
  public readonly workerLambda: ServiceLambda;
  /** Where a crashed or timed-out sync lands (async on-failure destination, round 2 N9). */
  public readonly workerFailureQueue: aws.sqs.Queue;
  public readonly workerInvokeConfig: aws.lambda.FunctionEventInvokeConfig;

  constructor(name: string, args: NerisEntityArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("NerisEntity", args.env);
    super("boxalarm:platform:NerisEntity", name, {}, opts);
    const { env } = args;

    const baseEnvironment = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-neris-entity-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "neris-entity-get"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]): IamPolicyStatement[] => [
            {
              Sid: "NerisEntityRead",
              Effect: "Allow",
              Action: ["dynamodb:GetItem"],
              Resource: tableArn,
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    this.workerFailureQueue = new aws.sqs.Queue(
      `${name}-sync-worker-failures`,
      {
        name: `boxalarm-${env}-platform-neris-entity-sync-failures`,
        messageRetentionSeconds: 14 * 86_400,
      },
      { parent: this },
    );

    // The NERIS calls run here, asynchronously (one per station and unit can outlast API
    // Gateway's 30 s limit). Reads the pending request and CONFIG#NERIS, saves the result
    // with its outbox record (two PutItems in one transaction). Only it reads the secret.
    this.workerLambda = new ServiceLambda(
      `${name}-sync-worker`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-neris-entity-sync-worker`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "neris-entity-sync-worker"),
        logGroup: args.logGroup,
        timeout: 300,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          NERIS_BASE_URL_PARAM: `/boxalarm/${env}/neris/base-url`,
          NERIS_USER_AGENT_PARAM: `/boxalarm/${env}/neris/user-agent`,
          NERIS_CREDENTIALS_SECRET_ID: args.nerisCredentialsSecretArn,
          BOXALARM_ENV: env,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.nerisCredentialsSecretArn])
          .apply(([tableArn, secretArn]): IamPolicyStatement[] => [
            {
              // UpdateItem: a crashed sync marks the row FAILED (entitySync.markSyncFailed).
              Sid: "NerisEntitySyncAccess",
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            ...nerisClientPolicyStatements(secretArn, env),
          ]),
      },
      { parent: this },
    );

    // No automatic retry: a re-run repeats NERIS calls, and the sync records its own FAILED
    // state. A crash or timeout goes to the failure queue, which alarms (round 2, N9).
    new aws.iam.RolePolicy(
      `${name}-sync-worker-on-failure`,
      {
        role: this.workerLambda.role.id,
        policy: this.workerFailureQueue.arn.apply((queueArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "NerisEntitySyncOnFailure",
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
    this.workerInvokeConfig = new aws.lambda.FunctionEventInvokeConfig(
      `${name}-sync-worker-invoke-config`,
      {
        functionName: this.workerLambda.function.name,
        maximumRetryAttempts: 0,
        // A sync start delayed in Lambda's async queue is dropped (to the failure queue)
        // rather than run minutes later over a newer request (round 2c, Q4).
        maximumEventAgeInSeconds: 60,
        destinationConfig: {
          onFailure: { destination: this.workerFailureQueue.arn },
        },
      },
      { parent: this },
    );

    // PUT validates, marks the row SYNCING (UpdateItem) and invokes the worker; no NERIS.
    this.putLambda = new ServiceLambda(
      `${name}-put`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-neris-entity-put`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "neris-entity-put"),
        logGroup: args.logGroup,
        environment: {
          ...baseEnvironment,
          NERIS_ENTITY_SYNC_WORKER: this.workerLambda.function.name,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn, this.workerLambda.function.arn])
          .apply(([tableArn, policyStoreArn, workerArn]): IamPolicyStatement[] => [
            {
              Sid: "NerisEntitySyncStart",
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
            {
              Sid: "InvokeNerisEntitySyncWorker",
              Effect: "Allow",
              Action: ["lambda:InvokeFunction"],
              Resource: workerArn,
            },
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/platform/neris/entity", lambda: this.getLambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-put-route`,
      { routeKey: "PUT /api/v1/platform/neris/entity", lambda: this.putLambda },
      { parent: this },
    );

    this.registerOutputs({
      getLambda: this.getLambda,
      putLambda: this.putLambda,
      workerLambda: this.workerLambda,
      workerFailureQueue: this.workerFailureQueue,
    });
  }

  /**
   * Pages the chief's LOB topic when a sync crashes or times out. A separate call because
   * the chief topic is created after this component in index.ts.
   */
  alarmOnSyncFailure(topicArn: pulumi.Input<string>): aws.cloudwatch.MetricAlarm {
    return new aws.cloudwatch.MetricAlarm(
      "neris-entity-sync-failed-alarm",
      {
        name: pulumi.interpolate`${this.workerFailureQueue.name}-depth`,
        alarmDescription:
          "A NERIS station/unit sync crashed or timed out (see the failure queue and GET /platform/neris/entity).",
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.workerFailureQueue.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [topicArn],
      },
      { parent: this },
    );
  }
}
