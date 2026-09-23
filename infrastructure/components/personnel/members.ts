import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface MembersArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

const TABLE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersTableAccess" as const,
      Effect: "Allow" as const,
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:TransactWriteItems",
        "dynamodb:Query",
      ],
      Resource: [arn, `${arn}/index/GSI3`],
    },
  ]);

/**
 * E2-S1-INFRA #203 roster routes: create/list/get/updateStatus, each its own
 * placeholder-code Lambda (real handlers already exist in
 * backend/src/services/personnel-service/members — see TODO in
 * placeholder-code.ts) scoped to the platform-service table + policy store.
 */
export class Members extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly listLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly updateStatusLambda: ServiceLambda;

  constructor(name: string, args: MembersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Members", args.env);
    super("boxalarm:personnel:Members", name, {}, opts);
    const { env } = args;

    const baseEnvironment = { PERSONNEL_TABLE_NAME: args.platformTableName };
    const baseStatements = pulumi
      .all([TABLE_STATEMENT(args.platformTableArn), pulumi.output(args.policyStoreArn)])
      .apply(([table, policyStoreArn]) => [
        ...table,
        verifiedPermissionsPolicyStatement(policyStoreArn),
      ]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-create`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: baseStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      { routeKey: "POST /api/v1/personnel/members", lambda: this.createLambda },
      { parent: this },
    );

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-list`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: baseStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      { routeKey: "GET /api/v1/personnel/members", lambda: this.listLambda },
      { parent: this },
    );

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-get`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: baseStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/personnel/members/{memberId}", lambda: this.getLambda },
      { parent: this },
    );

    this.updateStatusLambda = new ServiceLambda(
      `${name}-update-status`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-update-status`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        // No personnel role holds any permission on the alerting-service or
        // incident-service tables (issue AC4) — statements below are scoped to
        // the platform table alone, plus the audit-key mutation deny.
        additionalPolicyStatements: pulumi
          .all([baseStatements, pulumi.output(args.platformTableArn)])
          .apply(([statements, tableArn]) => [...statements, auditMutationDenyStatement(tableArn)]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-status-route`,
      {
        routeKey: "PUT /api/v1/personnel/members/{memberId}/status",
        lambda: this.updateStatusLambda,
      },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      getLambda: this.getLambda,
      updateStatusLambda: this.updateStatusLambda,
    });
  }
}
