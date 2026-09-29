import * as pulumi from "@pulumi/pulumi";
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
              Sid: "NerisEntitySyncAccess",
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            ...nerisClientPolicyStatements(secretArn, env),
          ]),
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
    });
  }
}
