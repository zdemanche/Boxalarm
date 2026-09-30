import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

/** Stack config key for the alerting-page email subscription. */
export const ALERTING_PAGE_EMAIL_CONFIG_KEY = "alertingPageEmail";

export interface AlertingPageTopicArgs {
  env: string;
}

/**
 * The alerting-page topic (E1-S11-INFRA): a standard SNS topic, distinct from the FIFO
 * delivery topic, that every alarm on the alert path pages through. Its own component,
 * created early in index.ts, because consumers built before AlertingAlarms feed paging too:
 * the outbox publisher, the eligibility and availability snapshot consumers and session
 * revocation (deploy-readiness M1).
 *
 * The page subscription is config-driven (`boxalarm-infra:alertingPageEmail`). Who carries
 * the pager is still open (#5), so this is a mechanism, not the final on-call route. It is
 * REQUIRED in prod — a prod stack whose alerting alarms page nobody fails preview — and
 * warned about at preview/up time in every other stack. An email subscription pages nobody
 * until its confirmation link is clicked: `scripts/check-alarm-subscriptions.mjs` checks.
 */
export class AlertingPageTopic extends pulumi.ComponentResource {
  public readonly topic: aws.sns.Topic;
  public readonly topicArn: pulumi.Output<string>;
  public readonly subscription?: aws.sns.TopicSubscription;

  constructor(name: string, args: AlertingPageTopicArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingPageTopic", args.env);
    super("boxalarm:alerting:AlertingPageTopic", name, {}, opts);
    const { env } = args;

    this.topic = new aws.sns.Topic(
      `${name}-topic`,
      { name: `boxalarm-${env}-alerting-page` },
      { parent: this },
    );
    this.topicArn = this.topic.arn;

    const pageEmail = new pulumi.Config("boxalarm-infra").get(ALERTING_PAGE_EMAIL_CONFIG_KEY);
    if (pageEmail) {
      this.subscription = new aws.sns.TopicSubscription(
        `${name}-email-subscription`,
        { topic: this.topic.arn, protocol: "email", endpoint: pageEmail },
        { parent: this },
      );
    } else if (env === "prod") {
      throw new Error(
        `AlertingPageTopic: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is required in prod — ` +
          `without it boxalarm-prod-alerting-page has no subscription and every alerting ` +
          `alarm pages nobody. Set it with \`pulumi config set ${ALERTING_PAGE_EMAIL_CONFIG_KEY} ` +
          `<address> --stack prod\`.`,
      );
    } else {
      pulumi.log.warn(
        `AlertingPageTopic: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is not set — ` +
          `boxalarm-${env}-alerting-page has no subscription, so every alerting alarm fires ` +
          `into the void. Set it, or confirm on-call routing is subscribed out-of-band.`,
        this,
      );
    }

    this.registerOutputs({ topicArn: this.topicArn });
  }
}
