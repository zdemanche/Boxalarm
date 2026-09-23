import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { invokeStubCode } from "./stub-code";

export interface EscalationArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  alertingTopicArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Voice escalation plumbing (E1-S3-INFRA): a dedicated EventBridge Scheduler group for
 * per-member T+N one-time timers, a scheduler execution role that may only invoke the
 * escalation Lambda, and the escalation Lambda itself.
 */
export class Escalation extends pulumi.ComponentResource {
  public readonly scheduleGroup: aws.scheduler.ScheduleGroup;
  public readonly schedulerRole: aws.iam.Role;
  public readonly lambda: ServiceLambda;
  /** ARN pattern scoping scheduler:CreateSchedule to schedules within this group only. */
  public readonly scheduleResourcePattern: pulumi.Output<string>;

  constructor(name: string, args: EscalationArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Escalation", args.env);
    super("boxalarm:alerting:Escalation", name, {}, opts);
    const { env } = args;
    const groupName = `boxalarm-${env}-alerting-escalation`;

    this.scheduleGroup = new aws.scheduler.ScheduleGroup(
      `${name}-group`,
      { name: groupName },
      { parent: this },
    );

    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    this.scheduleResourcePattern = pulumi.interpolate`arn:aws:scheduler:${region.name}:${caller.accountId}:schedule/${groupName}/*`;

    const escalationPolicy: pulumi.Input<IamPolicyStatement[]> = pulumi
      .all([args.alertingTableArn, args.alertingTopicArn])
      .apply(([tableArn, topicArn]) => [
        {
          Sid: "AlertingTableReadWrite",
          Effect: "Allow" as const,
          Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          Resource: tableArn,
        },
        {
          Sid: "AlertingTableTransact",
          Effect: "Allow" as const,
          Action: ["dynamodb:TransactWriteItems"],
          Resource: tableArn,
        },
        {
          Sid: "AlertingTopicPublish",
          Effect: "Allow" as const,
          Action: ["sns:Publish"],
          Resource: topicArn,
        },
      ]);

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-escalation`,
        handler: "index.handler",
        code: invokeStubCode(),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
        },
        additionalPolicyStatements: escalationPolicy,
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-alerting-escalation-scheduler`,
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
        permissionsBoundary: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-scheduler-role-policy`,
      {
        role: this.schedulerRole.id,
        policy: this.lambda.function.arn.apply((fnArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeEscalationOnly",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: fnArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.registerOutputs({
      scheduleGroup: this.scheduleGroup,
      schedulerRole: this.schedulerRole,
      lambda: this.lambda,
    });
  }
}
