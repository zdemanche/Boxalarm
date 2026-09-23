import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface AuditRouteArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E8-S5-INFRA #257 remaining piece: `GET /platform/audit` → audit/handler.ts.
 * The table (GSI3), the audit-key IAM deny helper, and CloudTrail data events
 * already exist (platform-table.ts, audit-trail.ts).
 */
export class AuditRoute extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: AuditRouteArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AuditRoute", args.env);
    super("boxalarm:platform:AuditRoute", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-audit`,
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: { AUDIT_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((tableArn) => [
          {
            Sid: "AuditQueryGsi3Only" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:Query"],
            Resource: `${tableArn}/index/GSI3`,
          },
        ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-route`,
      { routeKey: "GET /api/v1/platform/audit", lambda: this.lambda },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda });
  }
}
