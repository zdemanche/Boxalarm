import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceName } from "./services";
import { ServiceLogGroup } from "./service-log-group";
import { IamPolicyStatement, observabilityPolicyStatements } from "./observability-policy";
import { ACTIVE_TRACING_CONFIG } from "./xray-sampling";

export interface ServiceLambdaArgs {
  env: string;
  serviceName: ServiceName;
  /** Full Lambda function name, e.g. boxalarm-{env}-platform-authorizer */
  functionName: string;
  handler: string;
  code: pulumi.Input<pulumi.asset.Archive>;
  logGroup: ServiceLogGroup;
  /** Merged after SERVICE_NAME and ENVIRONMENT (those win if keys collide). */
  environment?: Record<string, pulumi.Input<string>>;
  additionalPolicyStatements?: pulumi.Input<IamPolicyStatement[]>;
  runtime?: aws.lambda.Runtime;
  timeout?: number;
  memorySize?: number;
  reservedConcurrentExecutions?: number;
  /** Forbidden for alerting-service — ENI cold start is unacceptable on the alert path. */
  vpcConfig?: pulumi.Input<aws.types.input.lambda.FunctionVpcConfig>;
  roleName?: string;
}

/**
 * Shared service-Lambda construct (E8-S11-INFRA). Every later infra child uses this
 * so Active tracing, the service log group, observability IAM, and SERVICE_NAME /
 * ENVIRONMENT are applied without bespoke wiring. Grants no DynamoDB access —
 * alerting isolation stays per-service.
 */
export class ServiceLambda extends pulumi.ComponentResource {
  public readonly function: aws.lambda.Function;
  public readonly role: aws.iam.Role;
  public readonly rolePolicy: aws.iam.RolePolicy;

  constructor(name: string, args: ServiceLambdaArgs, opts?: pulumi.ComponentResourceOptions) {
    if (typeof args.env !== "string" || args.env.length === 0) {
      throw new Error(`ServiceLambda: env is required (received ${JSON.stringify(args.env)})`);
    }
    if (typeof args.functionName !== "string" || args.functionName.length === 0) {
      throw new Error(
        `ServiceLambda: functionName is required (received ${JSON.stringify(args.functionName)})`,
      );
    }
    if (args.serviceName === "alerting-service" && args.vpcConfig !== undefined) {
      throw new Error(
        `ServiceLambda: alerting-service must not set VpcConfig (ENI cold start on the alert path)`,
      );
    }

    super("boxalarm:observability:ServiceLambda", name, {}, opts);

    const roleName = args.roleName ?? args.functionName;

    this.role = new aws.iam.Role(
      `${name}-role`,
      {
        name: roleName,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this },
    );

    this.rolePolicy = new aws.iam.RolePolicy(
      `${name}-role-policy`,
      {
        role: this.role.id,
        policy: pulumi
          .all([args.logGroup.logGroup.arn, args.additionalPolicyStatements ?? []])
          .apply(([logGroupArn, additional]) => {
            const statements: IamPolicyStatement[] = [
              ...observabilityPolicyStatements(logGroupArn, args.serviceName),
              ...(additional as IamPolicyStatement[]),
            ];
            return JSON.stringify({
              Version: "2012-10-17",
              Statement: statements,
            });
          }),
      },
      { parent: this },
    );

    const environmentVariables: Record<string, pulumi.Input<string>> = {
      ...(args.environment ?? {}),
      SERVICE_NAME: args.serviceName,
      ENVIRONMENT: args.env,
    };

    this.function = new aws.lambda.Function(
      `${name}-fn`,
      {
        name: args.functionName,
        runtime: args.runtime ?? aws.lambda.Runtime.NodeJS20dX,
        handler: args.handler,
        role: this.role.arn,
        code: args.code,
        timeout: args.timeout,
        memorySize: args.memorySize,
        reservedConcurrentExecutions: args.reservedConcurrentExecutions,
        tracingConfig: ACTIVE_TRACING_CONFIG,
        loggingConfig: {
          logFormat: "JSON",
          logGroup: args.logGroup.logGroupName,
        },
        environment: { variables: environmentVariables },
        vpcConfig: args.vpcConfig,
      },
      { parent: this, dependsOn: [args.logGroup.logGroup, this.rolePolicy] },
    );

    this.registerOutputs({
      function: this.function,
      role: this.role,
    });
  }
}
