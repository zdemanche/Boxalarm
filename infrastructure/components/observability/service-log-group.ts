import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { SERVICES, ServiceName } from "./services";

const KNOWN_SERVICES = new Set<string>(SERVICES);

export const RETENTION_DAYS_BY_ENV: Record<string, number> = {
  dev: 14,
  qa: 14,
  staging: 30,
  prod: 90,
};

export interface ServiceLogGroupArgs {
  env: string;
  serviceName: ServiceName;
}

export function serviceLogGroupName(env: string, serviceName: ServiceName): string {
  return `/aws/lambda/boxalarm-${env}-${serviceName}`;
}

export class ServiceLogGroup extends pulumi.ComponentResource {
  public readonly logGroup: aws.cloudwatch.LogGroup;
  // Cross-repo literal: one log group per service, shared by every route Lambda in it.
  // ServiceLambda sets loggingConfig.logGroup to this value for every route Lambda in
  // this service — Lambda's default per-function log group is NEVER_EXPIRE and bypasses
  // the retention this component provisions.
  public readonly logGroupName: string;

  constructor(name: string, args: ServiceLogGroupArgs, opts?: pulumi.ComponentResourceOptions) {
    if (typeof args.serviceName !== "string" || !KNOWN_SERVICES.has(args.serviceName)) {
      throw new Error(`ServiceLogGroup: unknown serviceName "${String(args.serviceName)}"`);
    }
    if (typeof args.env !== "string" || args.env.length === 0) {
      throw new Error(`ServiceLogGroup: env is required (received ${JSON.stringify(args.env)})`);
    }
    const retentionInDays = RETENTION_DAYS_BY_ENV[args.env];
    if (retentionInDays === undefined) {
      throw new Error(`ServiceLogGroup: unknown env "${args.env}" — no retention configured`);
    }

    super("boxalarm:observability:ServiceLogGroup", name, {}, opts);

    this.logGroupName = serviceLogGroupName(args.env, args.serviceName);

    this.logGroup = new aws.cloudwatch.LogGroup(
      `${name}-log-group`,
      {
        name: this.logGroupName,
        retentionInDays,
      },
      { parent: this },
    );

    this.registerOutputs({ logGroup: this.logGroup, logGroupName: this.logGroupName });
  }
}
