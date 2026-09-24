import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface QualsArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

const TABLE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "QualsTableAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/** E2-S2-INFRA #204: qualifications get/put, scoped to the platform table + policy store. */
export class Quals extends pulumi.ComponentResource {
  public readonly getLambda: ServiceLambda;
  public readonly putLambda: ServiceLambda;

  constructor(name: string, args: QualsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Quals", args.env);
    super("boxalarm:personnel:Quals", name, {}, opts);
    const { env } = args;

    const baseEnvironment = {
      PERSONNEL_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const additionalPolicyStatements = pulumi
      .all([TABLE_STATEMENT(args.platformTableArn), pulumi.output(args.policyStoreArn)])
      .apply(([table, policyStoreArn]) => [
        ...table,
        verifiedPermissionsPolicyStatement(policyStoreArn),
      ]);
    // One bundle (quals/handler.ts exports both getQualsHandler and putQualsHandler) — two
    // Lambdas differ only in which named export they invoke.
    const code = lambdaCode("personnel-service", "quals");

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-quals-get`,
        handler: "index.getQualsHandler",
        code,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/personnel/members/{memberId}/quals", lambda: this.getLambda },
      { parent: this },
    );

    this.putLambda = new ServiceLambda(
      `${name}-put`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-quals-put`,
        handler: "index.putQualsHandler",
        code,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-put-route`,
      { routeKey: "PUT /api/v1/personnel/members/{memberId}/quals", lambda: this.putLambda },
      { parent: this },
    );

    this.registerOutputs({ getLambda: this.getLambda, putLambda: this.putLambda });
  }
}
