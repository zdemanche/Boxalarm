import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { placeholderLambdaCode, PLACEHOLDER_LAMBDA_HANDLER } from "../shared/placeholder-code";
import { requireEnv } from "../shared/env";

export interface OutboxPublisherArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
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
        handler: PLACEHOLDER_LAMBDA_HANDLER,
        code: placeholderLambdaCode(),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          PLATFORM_BUS_NAME: args.busName,
          PLATFORM_EVENT_BUS_NAME: args.busName,
        },
        additionalPolicyStatements: pulumi.output(args.busArn).apply((busArn) => [
          {
            Sid: "PublishToPlatformBus",
            Effect: "Allow" as const,
            Action: ["events:PutEvents"],
            Resource: busArn,
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
