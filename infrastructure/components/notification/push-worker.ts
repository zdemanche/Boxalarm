import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";
import type { PushGatewaySecrets } from "../alerting/channel-workers";

export interface PushWorkerArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  /** boxalarm-{env}-notification-push — the topic digestJob/defect consumers publish to. */
  pushTopicArn: pulumi.Input<string>;
  /**
   * The APNs/FCM gateway credentials, shared with the alerting push worker: there is one
   * Apple/Firebase app, so there is one set of signing keys. Read-only, and only the three
   * this worker can use (APNs prod + sandbox for development-signed devices, FCM prod — it
   * never sends validate_only, so no FCM sandbox). Sharing a Secrets Manager secret crosses
   * no data-plane boundary: this Lambda holds NO permission on the alerting table, its CMK,
   * or any alerting queue, and the wiring test pins that.
   */
  pushSecrets: PushGatewaySecrets;
  logGroup: ServiceLogGroup;
  /** Ops alarm topic (chief-notifications): the DLQ and worker errors must never be silent. */
  opsAlarmTopicArn: pulumi.Input<string>;
}

/** The metric namespace push/worker.ts emits into (EMF). */
const PUSH_METRIC_NAMESPACE = "Boxalarm/NotificationPush";

/**
 * The non-critical push worker (design review M7): until this existed, every LOB push —
 * digests and the immediate out-of-service defect notice — was published to
 * boxalarm-{env}-notification-push and dropped, because nothing subscribed.
 *
 *   push topic -> raw SNS->SQS subscription (queue policy pinned to the topic ARN) -> SQS
 *   (DLQ after 5 receives, depth alarmed) -> push/worker.ts, which reads the member row's
 *   PUSH devices from the platform table and sends the hard-coded non-critical shape.
 *
 * LOB failure domain throughout: a standard (non-FIFO) queue, no reserved concurrency, a
 * small maximumConcurrency cap, and alarms to the ops topic — nothing here can consume
 * capacity the alert path depends on, and nothing here can read what the alert path owns.
 */
export class PushWorker extends pulumi.ComponentResource {
  public readonly queue: aws.sqs.Queue;
  public readonly dlq: aws.sqs.Queue;
  public readonly subscription: aws.sns.TopicSubscription;
  public readonly workerLambda: ServiceLambda;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly dlqDepthAlarm: aws.cloudwatch.MetricAlarm;
  public readonly errorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly sendFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: PushWorkerArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PushWorker", args.env);
    super("boxalarm:notification:PushWorker", name, {}, opts);
    const { env } = args;

    this.dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      {
        name: `boxalarm-${env}-notification-push-dlq`,
        // 14 days: a dropped member notification should survive a long weekend unseen.
        messageRetentionSeconds: 1_209_600,
      },
      { parent: this },
    );

    this.queue = new aws.sqs.Queue(
      `${name}-queue`,
      {
        name: `boxalarm-${env}-notification-push-queue`,
        // 6x the Lambda timeout, AWS's floor recommendation for ESM consumers.
        visibilityTimeoutSeconds: 180,
        redrivePolicy: this.dlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
        ),
      },
      { parent: this },
    );

    new aws.sqs.QueuePolicy(
      `${name}-queue-policy`,
      {
        queueUrl: this.queue.url,
        policy: pulumi.all([this.queue.arn, args.pushTopicArn]).apply(([queueArn, topicArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowNotificationPushTopicOnly",
                Effect: "Allow",
                Principal: { Service: "sns.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    // Raw delivery: the SQS body is the published JSON itself, exactly what the worker (and
    // the alerting channel queues before it) parse.
    this.subscription = new aws.sns.TopicSubscription(
      `${name}-subscription`,
      {
        topic: args.pushTopicArn,
        protocol: "sqs",
        endpoint: this.queue.arn,
        rawMessageDelivery: true,
      },
      { parent: this },
    );

    // push/worker.ts: GetItem (member METADATA devices, and writePushDevices' consistent
    // re-read); UpdateItem + PutItem only for the dead-token correction, which is
    // writePushDevices' own transaction (METADATA update + personnel.member.updated outbox
    // row). GetSecretValue on exactly the three gateway secrets. Nothing alerting-shaped.
    this.workerLambda = new ServiceLambda(
      `${name}-worker`,
      {
        env,
        serviceName: "notification-service",
        functionName: `boxalarm-${env}-notification-push-worker`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("notification-service", "push-worker"),
        logGroup: args.logGroup,
        // A batch is up to 10 members; each device send is budgeted at 8s in-process.
        timeout: 30,
        environment: {
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          APNS_SECRET_ID: args.pushSecrets.apns.name,
          APNS_SANDBOX_SECRET_ID: args.pushSecrets.apnsSandbox.name,
          FCM_SECRET_ID: args.pushSecrets.fcm.name,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            this.queue.arn,
            args.pushSecrets.apns.arn,
            args.pushSecrets.apnsSandbox.arn,
            args.pushSecrets.fcm.arn,
          ])
          .apply(([tableArn, queueArn, apnsArn, apnsSandboxArn, fcmArn]) => [
            {
              Sid: "ConsumePushQueueOnly" as const,
              Effect: "Allow" as const,
              Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
              Resource: [queueArn],
            },
            {
              Sid: "NotificationPushMemberRead" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem"],
              Resource: [tableArn],
            },
            {
              Sid: "NotificationPushTokenInvalidation" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem", "dynamodb:PutItem"],
              Resource: [tableArn],
            },
            auditMutationDenyStatement(tableArn),
            {
              Sid: "OwnPushGatewaySecretsOnly" as const,
              Effect: "Allow" as const,
              Action: ["secretsmanager:GetSecretValue"],
              Resource: [apnsArn, apnsSandboxArn, fcmArn],
            },
          ]),
      },
      { parent: this },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-event-source`,
      {
        eventSourceArn: this.queue.arn,
        functionName: this.workerLambda.function.name,
        functionResponseTypes: ["ReportBatchItemFailures"],
        scalingConfig: { maximumConcurrency: 5 },
      },
      { parent: this },
    );

    this.dlqDepthAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-dlq-depth-alarm`,
      {
        name: `boxalarm-${env}-notification-push-dlq-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.dlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        alarmActions: [args.opsAlarmTopicArn],
      },
      { parent: this },
    );

    this.errorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-errors-alarm`,
      {
        name: `boxalarm-${env}-notification-push-worker-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.workerLambda.function.name },
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        alarmActions: [args.opsAlarmTopicArn],
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    // A device-level send failure is retried via batchItemFailures and would only reach the
    // DLQ after 5 receives; this fires on the first failed attempt so a misconfigured
    // gateway (M7's silent-drop cousin) is seen before the DLQ fills.
    this.sendFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-send-failed-alarm`,
      {
        name: `boxalarm-${env}-notification-push-send-failed`,
        namespace: PUSH_METRIC_NAMESPACE,
        metricName: "PushSendFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        alarmActions: [args.opsAlarmTopicArn],
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.registerOutputs({
      queue: this.queue,
      dlq: this.dlq,
      workerLambda: this.workerLambda,
    });
  }
}
