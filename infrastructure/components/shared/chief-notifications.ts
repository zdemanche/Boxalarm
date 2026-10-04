import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "./env";

/** Stack config key for the chief-notifications email subscription. */
export const CHIEF_NOTIFICATION_EMAIL_CONFIG_KEY = "chiefNotificationEmail";

export interface ChiefNotificationTopicArgs {
  env: string;
}

/**
 * Chief-notification SNS topic (E8-S9-INFRA #260, shared with E8-S6-INFRA
 * #258): every export invocation and every disposal invocation notifies the
 * chief unconditionally. It is also the stack's ops alarm topic — every alarm that is not on
 * the alert path (LOB consumer DLQs, scanners, NERIS, HTTP API) notifies it (deploy-readiness
 * M1/M2).
 *
 * The subscription is config-driven (`boxalarm-infra:chiefNotificationEmail`): REQUIRED in
 * prod, where a topic nobody receives turns every ops alarm and chief notice silent, and
 * warned about everywhere else. Like alerting-page, an email subscription notifies nobody
 * until its confirmation link is clicked (`scripts/check-alarm-subscriptions.mjs`).
 */
export class ChiefNotificationTopic extends pulumi.ComponentResource {
  public readonly topic: aws.sns.Topic;
  public readonly topicArn: pulumi.Output<string>;
  public readonly subscription?: aws.sns.TopicSubscription;

  constructor(
    name: string,
    args: ChiefNotificationTopicArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("ChiefNotificationTopic", args.env);
    super("boxalarm:shared:ChiefNotificationTopic", name, {}, opts);
    const { env } = args;

    this.topic = new aws.sns.Topic(
      `${name}-topic`,
      { name: `boxalarm-${env}-chief-notifications` },
      {
        parent: this,
      },
    );
    this.topicArn = this.topic.arn;

    const email = new pulumi.Config("boxalarm-infra").get(CHIEF_NOTIFICATION_EMAIL_CONFIG_KEY);
    if (email) {
      this.subscription = new aws.sns.TopicSubscription(
        `${name}-email-subscription`,
        { topic: this.topic.arn, protocol: "email", endpoint: email },
        { parent: this },
      );
    } else if (env === "prod") {
      throw new Error(
        `ChiefNotificationTopic: boxalarm-infra:${CHIEF_NOTIFICATION_EMAIL_CONFIG_KEY} is required ` +
          `in prod — without it boxalarm-prod-chief-notifications has no subscription, so export ` +
          `and disposal notices and every ops alarm reach nobody. Set it with \`pulumi config set ` +
          `${CHIEF_NOTIFICATION_EMAIL_CONFIG_KEY} <address> --stack prod\`.`,
      );
    } else {
      pulumi.log.warn(
        `ChiefNotificationTopic: boxalarm-infra:${CHIEF_NOTIFICATION_EMAIL_CONFIG_KEY} is not set — ` +
          `boxalarm-${env}-chief-notifications has no subscription, so ops alarms and chief ` +
          `notices reach nobody. Set it, or subscribe the chief out-of-band.`,
        this,
      );
    }

    this.registerOutputs({ topicArn: this.topicArn });
  }
}
