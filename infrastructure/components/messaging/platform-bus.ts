import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";
import { QueueConsumer, QueueConsumerArgs } from "./queue-consumer";

export interface PlatformBusArgs {
  env: string;
}

/**
 * LOB EventBridge bus (E8-S8-INFRA #108). First consumer in build order owns
 * creation; every later INFRA child references the same instance from index.ts.
 */
export class PlatformBus extends pulumi.ComponentResource {
  public readonly bus: aws.cloudwatch.EventBus;
  public readonly busName: pulumi.Output<string>;
  public readonly busArn: pulumi.Output<string>;

  constructor(name: string, args: PlatformBusArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PlatformBus", args.env);
    super("boxalarm:messaging:PlatformBus", name, {}, opts);
    const { env } = args;

    this.bus = new aws.cloudwatch.EventBus(
      `${name}-bus`,
      { name: `boxalarm-${env}-platform-bus` },
      { parent: this },
    );

    this.busName = this.bus.name;
    this.busArn = this.bus.arn;

    this.registerOutputs({ busName: this.busName, busArn: this.busArn });
  }

  /** Rule on this bus → SQS queue (+DLQ) → the given Lambda. See queue-consumer.ts. */
  addQueueConsumer(
    name: string,
    args: Omit<QueueConsumerArgs, "busName" | "busArn">,
    opts?: pulumi.ComponentResourceOptions,
  ): QueueConsumer {
    return new QueueConsumer(
      name,
      { ...args, busName: this.busName, busArn: this.busArn },
      { parent: this, ...opts },
    );
  }
}
