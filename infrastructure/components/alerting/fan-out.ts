import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { Escalation } from "./escalation";

export interface FanOutArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  alertingStreamArn: pulumi.Input<string>;
  alertingTopicArn: pulumi.Input<string>;
  escalation: Escalation;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Fan-out Lambda (E1-S2-INFRA): triggered by the alerting-table DynamoDB Stream,
 * filtered to INSERT of DISPATCH_ALERT items, publishes one SNS FIFO message per
 * {member, channel} to the push/sms queues in parallel, and (E1-S3-INFRA) creates the
 * per-member voice escalation schedule and the department tone-2/3 evaluator timers.
 */
export class FanOut extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;

  constructor(name: string, args: FanOutArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("FanOut", args.env);
    super("boxalarm:alerting:FanOut", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-fan-out`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "fan-out"),
        logGroup: args.logGroup,
        // The stream path schedules each member's tone-1 voice escalation and the
        // department tone-2/3 ladder (fanout/fanOut.ts scheduleRealtimeFanOutEscalation);
        // scheduleEscalation.ts / toneLadder.ts throw when these are unset, which fails
        // the whole dispatch record.
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
          ESCALATION_HANDLER_ARN: args.escalation.lambda.function.arn,
          ESCALATION_SCHEDULER_ROLE_ARN: args.escalation.schedulerRole.arn,
          TONE_EVALUATOR_HANDLER_ARN: args.escalation.toneEvaluatorLambda.function.arn,
        },
        additionalPolicyStatements: args.escalation.scheduleResourcePattern.apply((pattern) => [
          {
            Sid: "AlertingTableReadWrite",
            Effect: "Allow" as const,
            Action: [
              "dynamodb:Query",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:TransactWriteItems",
            ],
            Resource: args.alertingTableArn as string,
          },
          {
            Sid: "AlertingTopicPublish",
            Effect: "Allow" as const,
            Action: ["sns:Publish"],
            Resource: args.alertingTopicArn as string,
          },
          {
            Sid: "CreateEscalationSchedulesOnly",
            Effect: "Allow" as const,
            Action: ["scheduler:CreateSchedule"],
            Resource: pattern,
          },
        ]),
        reservedConcurrentExecutions: 10,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-pass-scheduler-role`,
      {
        role: this.lambda.role.id,
        policy: args.escalation.schedulerRole.arn.apply((roleArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "PassSchedulerRoleOnly",
                Effect: "Allow",
                Action: "iam:PassRole",
                Resource: roleArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-event-source`,
      {
        eventSourceArn: args.alertingStreamArn,
        functionName: this.lambda.function.name,
        startingPosition: "LATEST",
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ["INSERT"],
                dynamodb: { NewImage: { entityType: { S: ["DISPATCH_ALERT"] } } },
              }),
            },
          ],
        },
      },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda, eventSourceMapping: this.eventSourceMapping });
  }
}
