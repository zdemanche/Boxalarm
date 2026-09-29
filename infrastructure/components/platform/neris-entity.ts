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
 * department's stations and units registered with its NERIS entity. Only the PUT calls
 * NERIS, so only it reads the OAuth secret. The PUT reads CONFIG#NERIS and NERIS#ENTITY
 * (GetItem) and writes the NERIS#ENTITY row plus its neris.entity.synced outbox record in one
 * transaction (two PutItems); the GET is a single GetItem.
 */
export class NerisEntity extends pulumi.ComponentResource {
  public readonly getLambda: ServiceLambda;
  public readonly putLambda: ServiceLambda;

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

    this.putLambda = new ServiceLambda(
      `${name}-put`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-neris-entity-put`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "neris-entity-put"),
        logGroup: args.logGroup,
        // One NERIS call per station and unit, sequential.
        timeout: 60,
        environment: {
          ...baseEnvironment,
          NERIS_BASE_URL_PARAM: `/boxalarm/${env}/neris/base-url`,
          NERIS_USER_AGENT_PARAM: `/boxalarm/${env}/neris/user-agent`,
          NERIS_CREDENTIALS_SECRET_ID: args.nerisCredentialsSecretArn,
          BOXALARM_ENV: env,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn, args.nerisCredentialsSecretArn])
          .apply(([tableArn, policyStoreArn, secretArn]): IamPolicyStatement[] => [
            {
              Sid: "NerisEntitySyncAccess",
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
            ...nerisClientPolicyStatements(secretArn, env),
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

    this.registerOutputs({ getLambda: this.getLambda, putLambda: this.putLambda });
  }
}
