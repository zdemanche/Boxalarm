import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { asyncStubCode } from "./stub-code";

export interface FanOutArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  alertingStreamArn: pulumi.Input<string>;
  alertingTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Fan-out Lambda (E1-S2-INFRA): triggered by the alerting-table DynamoDB Stream,
 * filtered to INSERT of DISPATCH_ALERT items, publishes one SNS FIFO message per
 * {member, channel} to the push/sms queues in parallel.
 *
 * Does NOT create voice escalation schedules — the backend stream handler
 * (fanout/handler.ts) never calls the Scheduler. Escalation scheduling happens on the
 * manual-dispatch ingress path instead (dispatches/handler.ts -> fanOut.ts ->
 * createEscalationSchedule), so the scheduler-create/PassRole grants live on
 * RoutesCore's dispatchIngress Lambda, not here (routes-core.ts).
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
        handler: "index.handler",
        code: asyncStubCode(),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
        },
        additionalPolicyStatements: pulumi.output(args.alertingStreamArn).apply((streamArn) => [
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
            // Required for the DynamoDB-stream event source mapping to be creatable at
            // all — CreateEventSourceMapping validates the execution role can call
            // GetRecords/GetShardIterator/DescribeStream on the stream ARN.
            Sid: "AlertingStreamRead",
            Effect: "Allow" as const,
            Action: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"],
            Resource: streamArn,
          },
          {
            // ListStreams has no ARN-level resource scoping (AWS-mandated wildcard,
            // like the XRayWrite statement in observability-policy.ts).
            Sid: "AlertingStreamListStreams",
            Effect: "Allow" as const,
            Action: ["dynamodb:ListStreams"],
            Resource: "*",
          },
        ]),
        reservedConcurrentExecutions: 10,
        // Fans out to up to 10 concurrent members at a time (fanOut.ts
        // MAX_CONCURRENT_FANOUT_TASKS), each doing a transact write + an SNS publish —
        // not bound by the API Gateway 29s ceiling since this is stream-triggered, not a
        // route, so size it for a large roster rather than the AWS 3s default.
        timeout: 30,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-event-source`,
      {
        eventSourceArn: args.alertingStreamArn,
        functionName: this.lambda.function.name,
        startingPosition: "LATEST",
        // The handler returns { batchItemFailures } instead of throwing (see
        // fanout/handler.ts) — without this, Lambda treats every invocation as a full
        // success and checkpoints past a failed dispatch with nobody ever paged.
        functionResponseTypes: ["ReportBatchItemFailures"],
        // Isolate a poison-pill record to its own half of the batch instead of retrying
        // (and blocking) the whole batch on every attempt.
        bisectBatchOnFunctionError: true,
        maximumRetryAttempts: 3,
        // A DISPATCH_ALERT stream record older than this is no longer actionable.
        maximumRecordAgeInSeconds: 3600,
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
