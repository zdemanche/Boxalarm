import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface ConfigArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E8-S4-INFRA #256 config route. Valkey is deliberately not provisioned: no
 * Valkey client or VALKEY_ENDPOINT config exists anywhere in
 * backend/src/services/platform-service/config/cache.ts as of this batch —
 * createHandler() always falls back to its in-process memoryStore(). An
 * ElastiCache Serverless cache nothing reads from would be pure idle cost
 * against the usage-based-only constraint (CLAUDE.md), so this ships without
 * the VPC/Valkey/gateway-endpoint stack the ticket describes; wire it once
 * the backend cache client lands. No alerting-plane Lambda gets a VpcConfig
 * here either way (AC5).
 */
export class Config extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: ConfigArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Config", args.env);
    super("boxalarm:platform:Config", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-config`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: { PLATFORM_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi
          .all([pulumi.output(args.platformTableArn), pulumi.output(args.policyStoreArn)])
          .apply(([tableArn, policyStoreArn]) => [
            {
              Sid: "ConfigTableAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/platform/config", lambda: this.lambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-put-route`,
      { routeKey: "PUT /api/v1/platform/config", lambda: this.lambda },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda });
  }
}
