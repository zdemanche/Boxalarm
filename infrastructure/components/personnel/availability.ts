import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface AvailabilityArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E2-S5-INFRA #207: planned unavailability (marking off) that suppresses alerting.
 * createAvailability creates one or two one-time EventBridge Scheduler schedules per
 * markoff (ACTIVATE/REVERT) targeting expiryHandler — the scheduler role is provisioned
 * here and its ARN + expiryHandler's ARN are handed to the create Lambda by env var, per
 * availability/handler.ts's readSchedulerConfig.
 */
export class Availability extends pulumi.ComponentResource {
  public readonly expiryLambda: ServiceLambda;
  public readonly createLambda: ServiceLambda;
  public readonly schedulerRole: aws.iam.Role;

  constructor(name: string, args: AvailabilityArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Availability", args.env);
    super("boxalarm:personnel:Availability", name, {}, opts);
    const { env } = args;

    const tableStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "AvailabilityTableAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        Resource: [arn],
      },
    ]);

    this.expiryLambda = new ServiceLambda(
      `${name}-expiry`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-availability-expiry`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "availability-expiry"),
        logGroup: args.logGroup,
        environment: { PLATFORM_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: tableStatement,
      },
      { parent: this },
    );

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-personnel-availability-scheduler`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-scheduler-role-policy`,
      {
        role: this.schedulerRole.id,
        policy: this.expiryLambda.function.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeAvailabilityExpiry",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-availability-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "availability-create"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
          AVAILABILITY_EXPIRY_HANDLER_ARN: this.expiryLambda.function.arn,
          AVAILABILITY_SCHEDULER_ROLE_ARN: this.schedulerRole.arn,
        },
        additionalPolicyStatements: pulumi
          .all([tableStatement, pulumi.output(args.policyStoreArn), this.schedulerRole.arn])
          .apply(([table, policyStoreArn, schedulerRoleArn]) => [
            ...table,
            verifiedPermissionsPolicyStatement(policyStoreArn),
            {
              Sid: "AvailabilityManageSchedules" as const,
              Effect: "Allow" as const,
              Action: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"],
              Resource: `arn:aws:scheduler:*:*:schedule/default/avail-*`,
            },
            {
              Sid: "AvailabilityPassSchedulerRole" as const,
              Effect: "Allow" as const,
              Action: ["iam:PassRole"],
              Resource: schedulerRoleArn,
            },
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      {
        routeKey: "POST /api/v1/personnel/members/{memberId}/availability",
        lambda: this.createLambda,
      },
      { parent: this },
    );

    this.registerOutputs({
      expiryLambda: this.expiryLambda,
      createLambda: this.createLambda,
      schedulerRole: this.schedulerRole,
    });
  }
}
