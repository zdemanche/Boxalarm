import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export interface PlatformBusArgs {
  env: string;
}

/**
 * LOB-plane EventBridge bus (E8-S7-INFRA). Pinned contract: bus name is literally
 * `boxalarm-{env}-platform-bus`; alerting-plane consumers subscribe rules off it but
 * never publish to it directly (outbox publishers own that).
 */
export class PlatformBus extends pulumi.ComponentResource {
  public readonly bus: aws.cloudwatch.EventBus;
  public readonly busName: pulumi.Output<string>;
  public readonly busArn: pulumi.Output<string>;

  constructor(name: string, args: PlatformBusArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PlatformBus", args.env);
    super("boxalarm:messaging:PlatformBus", name, {}, opts);

    this.bus = new aws.cloudwatch.EventBus(
      `${name}-bus`,
      { name: `boxalarm-${args.env}-platform-bus` },
      { parent: this },
    );

    this.busName = this.bus.name;
    this.busArn = this.bus.arn;

    this.registerOutputs({ busName: this.busName, busArn: this.busArn });
  }
}

const env = new pulumi.Config("boxalarm-infra").require("env");
export const platformBus = new PlatformBus("platform-bus", { env });
