import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface ShiftsArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E2-S7 through E2-S11-INFRA (#209-#213): duty shift definition, atomic claim/swap/release,
 * coverage visibility. shifts/handler.ts is a single router Lambda (routes on rawPath +
 * method internally) — one Lambda behind every /personnel/shifts... route, so the ANY
 * routes below all target the same function.
 */
export class Shifts extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: ShiftsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Shifts", args.env);
    super("boxalarm:personnel:Shifts", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-shifts`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "shifts"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              Sid: "ShiftsTableAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn, `${tableArn}/index/GSI3`],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-collection-route`,
      { routeKey: "ANY /api/v1/personnel/shifts", lambda: this.lambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-proxy-route`,
      { routeKey: "ANY /api/v1/personnel/shifts/{proxy+}", lambda: this.lambda },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda });
  }
}
