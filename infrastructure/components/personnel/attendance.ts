import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface AttendanceArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

const WRITE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "AttendanceWriteAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

const READ_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "AttendanceReadAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Resource: [arn, `${arn}/index/GSI1`],
    },
  ]);

/**
 * E2-S3-INFRA #205: attendance recording (self + on-behalf, one lambda export each from
 * the shared handler.ts/queryHandler.ts bundle) and query, scoped to the platform table
 * (PLATFORM_SERVICE_TABLE_NAME per dynamoClient.ts) + policy store.
 */
export class Attendance extends pulumi.ComponentResource {
  public readonly recordLambda: ServiceLambda;
  public readonly recordOnBehalfLambda: ServiceLambda;
  public readonly queryLambda: ServiceLambda;
  public readonly queryOnBehalfLambda: ServiceLambda;

  constructor(name: string, args: AttendanceArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Attendance", args.env);
    super("boxalarm:personnel:Attendance", name, {}, opts);
    const { env } = args;

    const baseEnvironment = {
      PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);
    const writeStatements = pulumi
      .all([WRITE_STATEMENT(args.platformTableArn), vpStatement])
      .apply(([table, vp]) => [...table, ...vp]);
    const readStatements = pulumi
      .all([READ_STATEMENT(args.platformTableArn), vpStatement])
      .apply(([table, vp]) => [...table, ...vp]);
    const recordCode = lambdaCode("personnel-service", "attendance-record");
    const queryCode = lambdaCode("personnel-service", "attendance-query");

    this.recordLambda = new ServiceLambda(
      `${name}-record`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-attendance-record`,
        handler: "index.handler",
        code: recordCode,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: writeStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-record-route`,
      { routeKey: "POST /api/v1/personnel/attendance", lambda: this.recordLambda },
      { parent: this },
    );

    this.recordOnBehalfLambda = new ServiceLambda(
      `${name}-record-on-behalf`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-attendance-record-on-behalf`,
        handler: "index.onBehalfHandler",
        code: recordCode,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: writeStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-record-on-behalf-route`,
      {
        routeKey: "POST /api/v1/personnel/members/{memberId}/attendance",
        lambda: this.recordOnBehalfLambda,
      },
      { parent: this },
    );

    this.queryLambda = new ServiceLambda(
      `${name}-query`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-attendance-query`,
        handler: "index.handler",
        code: queryCode,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: readStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-query-route`,
      { routeKey: "GET /api/v1/personnel/attendance", lambda: this.queryLambda },
      { parent: this },
    );

    this.queryOnBehalfLambda = new ServiceLambda(
      `${name}-query-on-behalf`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-attendance-query-on-behalf`,
        handler: "index.onBehalfHandler",
        code: queryCode,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: readStatements,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-query-on-behalf-route`,
      {
        routeKey: "GET /api/v1/personnel/members/{memberId}/attendance",
        lambda: this.queryOnBehalfLambda,
      },
      { parent: this },
    );

    this.registerOutputs({
      recordLambda: this.recordLambda,
      recordOnBehalfLambda: this.recordOnBehalfLambda,
      queryLambda: this.queryLambda,
      queryOnBehalfLambda: this.queryOnBehalfLambda,
    });
  }
}
