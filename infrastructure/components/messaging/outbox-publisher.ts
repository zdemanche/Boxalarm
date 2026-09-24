import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface OutboxPublisherArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  platformTableStreamArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/**
 * The ONE platform-table outbox → platform-bus publisher Lambda (E2-S1-INFRA
 * #42). DynamoDB Streams NEW_IMAGE, filtered to `entityType = OUTBOX_ENTRY` so
 * every service's stream traffic funnels through this single publisher rather
 * than one per service (the triple-publish trap the ticket names).
 */
export class OutboxPublisher extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly onFailureQueue: aws.sqs.Queue;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly onFailureAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: OutboxPublisherArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("OutboxPublisher", args.env);
    super("boxalarm:messaging:OutboxPublisher", name, {}, opts);
    const { env } = args;

    this.onFailureQueue = new aws.sqs.Queue(
      `${name}-onfailure`,
      { name: `boxalarm-${env}-outbox-publisher-onfailure` },
      { parent: this },
    );

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-outbox-publisher`,
        handler: LAMBDA_HANDLER,
        // No matching handler in backend/src/services/platform-service yet (the
        // existing outbox publisher, personnel-service/outbox/publisher.ts, is
        // hardcoded to the personnel table, not this generic platform-table one)
        // — stays on the placeholder fallback until that handler lands.
        code: lambdaCode("platform-service", "outbox-publisher"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          PLATFORM_BUS_NAME: args.busName,
          PLATFORM_EVENT_BUS_NAME: args.busName,
        },
        additionalPolicyStatements: pulumi
          .all([args.busArn, args.platformTableArn])
          .apply(([busArn, tableArn]) => [
            {
              Sid: "PublishToPlatformBus",
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
            {
              // The real publisher (personnel-service/outbox/publisher.ts) runs an
              // UpdateItem to SET sentAt after each successful PutEvents. Without
              // this grant that update is denied and the handler throws — and
              // because the event is published BEFORE the failing update, every
              // stream-mapping retry re-publishes it, flooding the bus with
              // duplicates for as long as the mapping keeps retrying.
              Sid: "MarkOutboxEntrySent" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem"],
              Resource: tableArn,
            },
          ]),
      },
      { parent: this },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-esm`,
      {
        eventSourceArn: args.platformTableStreamArn,
        functionName: this.lambda.function.name,
        startingPosition: "LATEST",
        batchSize: 10,
        bisectBatchOnFunctionError: true,
        // Stream-mapping defaults are UNBOUNDED (-1) retry attempts and record age.
        // Because PutEvents runs before the (previously-denied) sentAt UpdateItem,
        // an unbounded retry re-published every event in the batch on every retry —
        // duplicate personnel.member.updated events flooding the bus, each one
        // re-driving session revocation, for up to the stream's 24h retention.
        // Bounded here so a stuck shard fails out to onFailure instead.
        maximumRetryAttempts: 5,
        maximumRecordAgeInSeconds: 3600,
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                dynamodb: { NewImage: { entityType: { S: ["OUTBOX_ENTRY"] } } },
              }),
            },
          ],
        },
        destinationConfig: { onFailure: { destinationArn: this.onFailureQueue.arn } },
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-stream-read-policy`,
      {
        role: this.lambda.role.id,
        policy: pulumi.output(args.platformTableStreamArn).apply((streamArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadPlatformTableStream",
                Effect: "Allow",
                Action: [
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:DescribeStream",
                  "dynamodb:ListStreams",
                ],
                Resource: streamArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.onFailureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-onfailure-alarm`,
      {
        name: `boxalarm-${env}-outbox-publisher-onfailure-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.onFailureQueue.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda, onFailureQueue: this.onFailureQueue });
  }
}
