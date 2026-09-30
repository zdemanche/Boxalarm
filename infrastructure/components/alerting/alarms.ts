import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";
import { ALERTING_CHANNELS, AlertingChannel, ChannelQueue } from "./messaging-alerting";

const NON_PROD_ENVS = new Set(["dev", "qa", "staging"]);

/** Backend namespace of the tone-1 fan-out's metrics (fanout/handler.ts METRIC_NAMESPACE). */
export const FAN_OUT_METRIC_NAMESPACE = "Boxalarm/alerting-fan-out";

export interface AlertingAlarmsArgs {
  env: string;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  fanOutFunctionName: pulumi.Input<string>;
  /** Fan-out stream ESM on-failure destination — a record here is a dispatch nobody was paged for. */
  fanOutOnFailureQueue: aws.sqs.Queue;
  escalationFunctionName: pulumi.Input<string>;
  toneEvaluatorFunctionName: pulumi.Input<string>;
  /** Async on-failure destination of escalation + tone evaluator — a record is a lost page. */
  escalationOnFailureQueue: aws.sqs.Queue;
  memberUpdatedDlq: aws.sqs.Queue;
  memberUpdatedFunctionName: pulumi.Input<string>;
}

/**
 * Stack config key: the fewest eligible members a real dispatch may reach before it pages
 * on-call (default DEFAULT_MIN_ELIGIBLE_MEMBERS). Set it near the department's usual turnout.
 */
export const MIN_ELIGIBLE_MEMBERS_CONFIG_KEY = "alertingMinEligibleMembers";
export const DEFAULT_MIN_ELIGIBLE_MEMBERS = 3;

/** Stack config key for the alerting-page email subscription. */
export const ALERTING_PAGE_EMAIL_CONFIG_KEY = "alertingPageEmail";

/**
 * Alerting-plane paging (E1-S11-INFRA): a dedicated standard SNS topic
 * (`alerting-page`, distinct from the FIFO delivery topic) that every alerting alarm
 * pages through, an alarm on every alert-path failure mode, and a per-channel
 * fault-injection SSM switch present in dev/qa/staging only (never prod).
 *
 * The page subscription is config-driven (`boxalarm-infra:alertingPageEmail`). Who carries
 * the pager is still open (#5), so this is a mechanism, not the final on-call route. It is
 * REQUIRED in prod — a prod stack whose alerting alarms page nobody fails preview — and
 * warned about at preview/up time in every other stack.
 */
/**
 * What a message in each channel DLQ means. Every page in a DLQ failed all its attempts. The
 * push text names the configuration faults that deliberately dead-letter instead of being
 * swallowed (review minor 2): a misconfigured stack must page, not fail quietly.
 */
const DLQ_ALARM_DESCRIPTION: Record<AlertingChannel, string> = {
  push:
    "A push page failed every attempt and was dead-lettered; the member got no push for that tone (SMS runs in parallel). " +
    "Check the push worker logs (alerting.channel.send_failed) for the gateway reason and which members are affected. " +
    "ONE member, every tone: usually a benign stale token - that member's registered token comes from another app bundle or Firebase project " +
    "(e.g. an old or side-loaded build: APNs DeviceTokenNotForTopic, FCM SENDER_ID_MISMATCH). The secrets are fine; " +
    "ask the member to reinstall/re-open the current app, then discard those DLQ messages. " +
    "MANY members: a stack misconfiguration that dead-letters on purpose - bundleId in the APNs secret does not match the app, " +
    "the FCM service account is from a different Firebase project, credentials still refused after the in-process retry " +
    "(rotated/revoked .p8 key or service account), a blocked mass token invalidation (APNs secret environment does not match the app builds), " +
    "or an unset push secret. Fix the secret, then redrive the DLQ. " +
    "A blocked mass invalidation can also be benign: several members uninstalled at once (their pages could never be delivered).",
  sms: "An SMS page failed every attempt and was dead-lettered; the member got no SMS for that tone. Check the sms worker logs (alerting.channel.send_failed), fix the provider, then redrive the DLQ.",
  voice:
    "A voice escalation failed every attempt and was dead-lettered; the member got no call for that tone. Check the voice worker logs (alerting.channel.send_failed), fix the provider, then redrive the DLQ.",
};

export class AlertingAlarms extends pulumi.ComponentResource {
  public readonly pageTopic: aws.sns.Topic;
  public readonly pageSubscription?: aws.sns.TopicSubscription;
  public readonly faultInjectionParameters: Partial<Record<AlertingChannel, aws.ssm.Parameter>>;

  constructor(name: string, args: AlertingAlarmsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingAlarms", args.env);
    super("boxalarm:alerting:AlertingAlarms", name, {}, opts);
    const { env } = args;

    this.pageTopic = new aws.sns.Topic(
      `${name}-page-topic`,
      { name: `boxalarm-${env}-alerting-page` },
      { parent: this },
    );

    const pageEmail = new pulumi.Config("boxalarm-infra").get(ALERTING_PAGE_EMAIL_CONFIG_KEY);
    if (pageEmail) {
      this.pageSubscription = new aws.sns.TopicSubscription(
        `${name}-page-email-subscription`,
        { topic: this.pageTopic.arn, protocol: "email", endpoint: pageEmail },
        { parent: this },
      );
    } else if (env === "prod") {
      throw new Error(
        `AlertingAlarms: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is required in prod — ` +
          `without it boxalarm-prod-alerting-page has no subscription and every alerting ` +
          `alarm pages nobody. Set it with \`pulumi config set ${ALERTING_PAGE_EMAIL_CONFIG_KEY} ` +
          `<address> --stack prod\`.`,
      );
    } else {
      pulumi.log.warn(
        `AlertingAlarms: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is not set — ` +
          `boxalarm-${env}-alerting-page has no subscription, so every alerting alarm fires ` +
          `into the void. Set it, or confirm on-call routing is subscribed out-of-band.`,
        this,
      );
    }

    const pageAlarm = (
      key: string,
      alarm: Omit<aws.cloudwatch.MetricAlarmArgs, "alarmActions" | "treatMissingData">,
    ): aws.cloudwatch.MetricAlarm =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${key}`,
        { ...alarm, treatMissingData: "notBreaching", alarmActions: [this.pageTopic.arn] },
        { parent: this },
      );

    const lambdaAlarm = (
      key: string,
      functionName: pulumi.Input<string>,
      metricName: "Errors" | "Throttles",
      alarmName: string,
    ) =>
      pageAlarm(key, {
        name: alarmName,
        namespace: "AWS/Lambda",
        metricName,
        dimensions: { FunctionName: functionName },
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
      });

    // Fan-out: Errors, a stuck stream (IteratorAge), and any record that exhausted its
    // retries into the on-failure queue — each is a dispatch that may have paged nobody.
    lambdaAlarm(
      "fan-out-errors-alarm",
      args.fanOutFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-fan-out-errors`,
    );
    pageAlarm("fan-out-iterator-age-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-iterator-age`,
      namespace: "AWS/Lambda",
      metricName: "IteratorAge",
      dimensions: { FunctionName: args.fanOutFunctionName },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      // 60s: a DISPATCH_ALERT unprocessed for a minute is already a missed tone-out.
      threshold: 60_000,
      period: 60,
      evaluationPeriods: 1,
    });
    pageAlarm("fan-out-onfailure-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-onfailure-not-empty`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.fanOutOnFailureQueue.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // Design review C1: a tone-1 receipt that already carries sentAt on a dispatch's FIRST
    // fan-out attempt was written by something other than the fan-out, and that member is not
    // paged until tone 2. A retry legitimately skips what it already sent, so only the
    // first-pass count (fanout/handler.ts sendOne) is alarmed.
    pageAlarm("fan-out-duplicate-first-pass-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-tone1-duplicate-first-pass`,
      alarmDescription:
        "The fan-out found a tone-1 receipt already marked sent on the dispatch's first attempt and skipped that member: " +
        "a second producer wrote the exactly-once key and did not publish, so the member gets no page until tone 2. " +
        "Check the fan-out logs (fanout.receipt.duplicate_on_first_pass) for the dispatch and members, and find the other writer of RECEIPT# items.",
      namespace: FAN_OUT_METRIC_NAMESPACE,
      metricName: "DuplicateSkippedFirstPass",
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // Escalation and tone-evaluator are invoked async by EventBridge Scheduler. After Lambda's
    // retries a failed event lands in the on-failure queue (escalation.ts); any message there
    // is a tone, voice escalation or mutual-aid request that did not complete.
    pageAlarm("escalation-onfailure-alarm", {
      name: `boxalarm-${env}-alerting-escalation-onfailure`,
      alarmDescription:
        "A voice escalation, tone 2/3 or mutual-aid request did not complete. Runbook: docs/runbooks/alerting-escalation-onfailure.md (redrive: infrastructure/scripts/redrive-escalation-onfailure.sh).",
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.escalationOnFailureQueue.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });
    lambdaAlarm(
      "escalation-errors-alarm",
      args.escalationFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-escalation-errors`,
    );
    lambdaAlarm(
      "escalation-throttles-alarm",
      args.escalationFunctionName,
      "Throttles",
      `boxalarm-${env}-alerting-escalation-throttles`,
    );
    lambdaAlarm(
      "tone-evaluator-errors-alarm",
      args.toneEvaluatorFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-tone-evaluator-errors`,
    );
    lambdaAlarm(
      "tone-evaluator-throttles-alarm",
      args.toneEvaluatorFunctionName,
      "Throttles",
      `boxalarm-${env}-alerting-tone-evaluator-throttles`,
    );

    // A lost personnel.member.updated event means a member silently stops getting push.
    // (Replaces push-tokens' action-less member-updated-dlq-depth alarm; new physical name
    // so replacing it cannot delete the new alarm by name.)
    pageAlarm("member-updated-dlq-alarm", {
      name: `boxalarm-${env}-alerting-member-updated-dlq-not-empty`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.memberUpdatedDlq.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // The consumer throws on a bad record or a DynamoDB failure; the DLQ alarm only fires
    // after 5 receives, so page on the errors themselves too.
    lambdaAlarm(
      "member-updated-errors-alarm",
      args.memberUpdatedFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-member-updated-consumer-errors`,
    );

    // Push token invalidations (review M3). APNs answers BadDeviceToken both for a dead token
    // and for one sent to the wrong APNs environment, so a burst of invalidations usually means
    // the stack's APNs secret `environment` (or bundle id) does not match the installed app
    // builds, not that members' phones died. Past 3 distinct tokens in the current and previous
    // 5-minute windows the worker trips a latch: no further invalidations for 24 hours, and those
    // pages throw instead (MassInvalidationBlocked). Both are paged.
    pageAlarm("push-token-invalid-rate-alarm", {
      name: `boxalarm-${env}-alerting-push-token-invalid-rate`,
      alarmDescription:
        "More than 3 push tokens were rejected as invalid in 5 minutes. Usually a push gateway misconfiguration: check the APNs secret's environment (production for TestFlight/App Store builds, sandbox for Xcode-installed builds) and bundleId, and the FCM service account's project. It can also be benign - several members uninstalled or reset their phones at once; if the logs show only those members and the secrets are right, no action is needed. Members whose token was invalidated get push again after re-opening the app.",
      namespace: "Boxalarm/AlertingChannel",
      metricName: "TokenInvalid",
      // deliverChannelMessage emits emitOutcomeMetric(ns, "TokenInvalid", "push") → Reason=push.
      dimensions: { Reason: "push" },
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 3,
      period: 300,
      evaluationPeriods: 1,
    });
    pageAlarm("push-mass-invalidation-blocked-alarm", {
      name: `boxalarm-${env}-alerting-push-mass-invalidation-blocked`,
      alarmDescription:
        "The push worker tripped its mass-invalidation latch (more than 3 tokens rejected within ~10 minutes) and is failing those pages instead of disabling members' push. Usually a push gateway misconfiguration: fix it (APNs environment/bundleId, FCM project), then delete the TRIPPED and RECENT_TRIP items under DEPT#{deptId}#PUSH_TOKEN_INVALIDATION in the alerting table. Otherwise no token is invalidated for 24 hours after the trip. It can also be benign - several members uninstalled at once, whose pages could never be delivered; then let it lapse. Pages retry and dead-letter meanwhile. SMS still pages in parallel.",
      namespace: "Boxalarm/AlertingChannel",
      metricName: "MassInvalidationBlocked",
      dimensions: { Reason: "push" },
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // Design review M6: a real dispatch that could page nobody, or too few. A deptId mismatch,
    // a dead eligibility consumer or a mass mark-off otherwise looks exactly like a quiet night.
    pageAlarm("fan-out-empty-roster-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-empty-roster`,
      alarmDescription:
        "A real dispatch fanned out to nobody: no eligible member had any reachable channel. Check the eligibility snapshot " +
        "(DEPT#{deptId}#ELIGIBILITY in the alerting table) for the dispatch's deptId, the member-updated / availability consumers' DLQs, " +
        "and that the stack deptId matches the members' custom:deptId. Radio tone-out (N1.9) is the page of record until fixed.",
      namespace: FAN_OUT_METRIC_NAMESPACE,
      metricName: "EmptyRoster",
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });
    const minEligible =
      new pulumi.Config("boxalarm-infra").getNumber(MIN_ELIGIBLE_MEMBERS_CONFIG_KEY) ??
      DEFAULT_MIN_ELIGIBLE_MEMBERS;
    pageAlarm("fan-out-small-roster-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-small-roster`,
      alarmDescription:
        `A real dispatch reached fewer than ${minEligible} eligible members (stack config ${MIN_ELIGIBLE_MEMBERS_CONFIG_KEY}). ` +
        "Usually members missing from the eligibility snapshot or marked off; check the snapshot and the eligibility consumers.",
      namespace: FAN_OUT_METRIC_NAMESPACE,
      metricName: "EligibleMemberCount",
      statistic: "Minimum",
      comparisonOperator: "LessThanThreshold",
      threshold: minEligible,
      period: 60,
      evaluationPeriods: 1,
    });

    // Design review C2: an eligible member with no phone is never published on SMS (the
    // fan-out checks the target first) - counted, and paged here, instead of silently skipped.
    pageAlarm("fan-out-sms-skipped-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-sms-skipped`,
      alarmDescription:
        "The tone-1 fan-out found an eligible member with no SMS contact entry and could not text them. " +
        "The snapshot's SMS/VOICE entries are projected from the member's phone by the member-updated consumer; " +
        "check the member has a phone in personnel, then the consumer's DLQ and logs (fanout.sms.skipped names the member).",
      namespace: FAN_OUT_METRIC_NAMESPACE,
      metricName: "SmsSkipped",
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // Review R2-m1: a real page whose push gateway secret is unset or unreadable - e.g. a device
    // registered as `development` (an Xcode-installed build) with no APNs sandbox secret value.
    pageAlarm("push-credentials-unavailable-alarm", {
      name: `boxalarm-${env}-alerting-push-credentials-unavailable`,
      alarmDescription:
        "A real push page could not be sent because a push gateway secret is unset or has no value. The push worker logs " +
        "(alerting.channel.device_send_failed) name the secret. APNS_SANDBOX_SECRET_ID is needed on any stack where Xcode-installed " +
        "(development-signed) builds register; APNS_SECRET_ID / FCM_SECRET_ID on every stack. Set the value, then redrive the push DLQ.",
      namespace: "Boxalarm/AlertingChannel",
      metricName: "PushCredentialsUnavailable",
      dimensions: { Reason: "push" },
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    for (const channel of ALERTING_CHANNELS) {
      const dlq = args.channelQueues[channel].dlq;

      // A real page the worker had no target for is acknowledged with no DLQ entry and no
      // SendFailed - before this alarm, the silent shape of the SMS-never-sends defect (C2).
      // deliverChannelMessage emits emitOutcomeMetric(ns, "NoTargetRegistered", channel).
      pageAlarm(`${channel}-no-target-alarm`, {
        name: `boxalarm-${env}-alerting-${channel}-no-target`,
        alarmDescription:
          `A ${channel} page reached the worker for a member with no ${channel} target in the eligibility snapshot, and was dropped. ` +
          "Check alerting.channel.no_target in the worker logs for the member, then their contact entries (SMS/VOICE come from the member's phone, PUSH from a registered device).",
        namespace: "Boxalarm/AlertingChannel",
        metricName: "NoTargetRegistered",
        dimensions: { Reason: channel },
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
      });

      // A worker that is consuming but stuck (hung vendor call) before anything reaches
      // the DLQ. A healthy queue never holds a message this long.
      pageAlarm(`${channel}-oldest-message-alarm`, {
        name: `boxalarm-${env}-alerting-${channel}-oldest-message-age`,
        namespace: "AWS/SQS",
        metricName: "ApproximateAgeOfOldestMessage",
        dimensions: { QueueName: args.channelQueues[channel].queue.name },
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 120,
        period: 60,
        evaluationPeriods: 2,
      });

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-dlq-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-dlq-not-empty`,
          alarmDescription: DLQ_ALARM_DESCRIPTION[channel],
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensions: { QueueName: dlq.name },
          statistic: "Maximum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-delivery-failure-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-delivery-failure-rate`,
          namespace: `Boxalarm/AlertingChannel`,
          metricName: "SendFailed",
          // Cross-seam contract: deliverChannelMessage.ts emits
          // emitOutcomeMetric("Boxalarm/AlertingChannel", "SendFailed", channel), and
          // @boxalarm/metrics publishes that reason under the `Reason` dimension (dimension
          // sets [] and ["Reason"]). There is no `channel` dimension — alarming on one
          // matched no series, so this alarm could never fire.
          dimensions: { Reason: channel },
          statistic: "Sum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );
    }

    this.faultInjectionParameters = NON_PROD_ENVS.has(env)
      ? Object.fromEntries(
          ALERTING_CHANNELS.map((channel) => [
            channel,
            new aws.ssm.Parameter(
              `${name}-${channel}-fault-injection`,
              {
                name: `/boxalarm/${env}/alerting/${channel}/fault-injection`,
                type: "String",
                value: "off",
                description: `Non-prod fault-injection switch for the ${channel} worker`,
              },
              { parent: this },
            ),
          ]),
        )
      : {};

    this.registerOutputs({ pageTopic: this.pageTopic });
  }
}
