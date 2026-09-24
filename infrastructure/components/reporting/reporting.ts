import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface ReportingArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** Query-only, no dynamodb:Scan — every reporting route reads GSIs on the platform table. */
const QUERY_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "ReportingQueryAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:Query"],
      Resource: [arn, `${arn}/index/*`],
    },
  ]);

/**
 * reporting-service read routes (E7-S3-INFRA #249, E7-S5-INFRA #251,
 * E7-S7-INFRA #252): each queries the shared platform-service table only —
 * every service-scoped env var name (PLATFORM_SERVICE_TABLE_NAME,
 * PERSONNEL_TABLE_NAME, TRAINING_DYNAMO_TABLE_NAME) is that same table, per
 * the architecture's single platform-table domain-per-service-name convention
 * (see personnel/members.ts's PERSONNEL_TABLE_NAME for the same pattern).
 *
 * #251's incident-table + CMK grant (grants report's incident-volume figure)
 * is not wired: grants/assembleReport.ts's caller hardcodes
 * `incidentVolume: { available: false, reason: 'E6-S1' }` today, so the
 * Lambda makes no incident-table call this grant would authorize.
 */
export class Reporting extends pulumi.ComponentResource {
  public readonly losapYearEndLambda: ServiceLambda;
  public readonly grantsLambda: ServiceLambda;
  public readonly membershipTrendsLambda: ServiceLambda;

  constructor(name: string, args: ReportingArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Reporting", args.env);
    super("boxalarm:reporting:Reporting", name, {}, opts);
    const { env } = args;

    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);
    const baseEnvironment = {
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    this.losapYearEndLambda = new ServiceLambda(
      `${name}-losap-year-end`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-losap-year-end`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "losap-year-end"),
        logGroup: args.logGroup,
        environment: { ...baseEnvironment, PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi
          .all([QUERY_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-losap-year-end-route`,
      { routeKey: "GET /api/v1/reporting/losap/year-end", lambda: this.losapYearEndLambda },
      { parent: this },
    );

    this.grantsLambda = new ServiceLambda(
      `${name}-grants`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-grants`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "grants"),
        logGroup: args.logGroup,
        environment: {
          ...baseEnvironment,
          PERSONNEL_TABLE_NAME: args.platformTableName,
          TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([QUERY_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-grants-route`,
      { routeKey: "GET /api/v1/reporting/grants", lambda: this.grantsLambda },
      { parent: this },
    );

    this.membershipTrendsLambda = new ServiceLambda(
      `${name}-membership-trends`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-membership-trends`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "membership-trends"),
        logGroup: args.logGroup,
        environment: {
          ...baseEnvironment,
          PERSONNEL_TABLE_NAME: args.platformTableName,
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([QUERY_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-membership-trends-route`,
      { routeKey: "GET /api/v1/reporting/membership-trends", lambda: this.membershipTrendsLambda },
      { parent: this },
    );

    this.registerOutputs({
      losapYearEndLambda: this.losapYearEndLambda,
      grantsLambda: this.grantsLambda,
      membershipTrendsLambda: this.membershipTrendsLambda,
    });
  }
}
