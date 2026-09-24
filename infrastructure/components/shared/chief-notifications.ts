import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "./env";

export interface ChiefNotificationTopicArgs {
  env: string;
}

/**
 * Chief-notification SNS topic (E8-S9-INFRA #260, shared with E8-S6-INFRA
 * #258): every export invocation and every disposal invocation notifies the
 * chief unconditionally — subscription is out-of-band (chief's own contact).
 */
export class ChiefNotificationTopic extends pulumi.ComponentResource {
  public readonly topic: aws.sns.Topic;
  public readonly topicArn: pulumi.Output<string>;

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

    this.registerOutputs({ topicArn: this.topicArn });
  }
}
