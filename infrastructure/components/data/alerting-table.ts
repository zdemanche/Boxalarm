import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { dynamodbCmkPolicy } from "./cmk-policy";

const KNOWN_ENVS = new Set(["dev", "qa", "staging", "prod"]);

export interface AlertingTableArgs {
  env: string;
}

function requireEnv(component: string, env: string): void {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error(`${component}: env is required (received ${JSON.stringify(env)})`);
  }
  if (!KNOWN_ENVS.has(env)) {
    throw new Error(`${component}: unknown env "${env}"`);
  }
}

/**
 * Alerting-plane DynamoDB table (E5 / #48 table portion).
 * Customer-managed KMS, on-demand, PITR, Streams NEW_IMAGE (not NEW_AND_OLD),
 * TTL on attribute `ttl`, GSI1 + GSI2. Alerting isolation is an IAM boundary —
 * this component does not grant any service role access.
 */
export class AlertingTable extends pulumi.ComponentResource {
  public readonly table: aws.dynamodb.Table;
  public readonly cmk: aws.kms.Key;
  public readonly tableName: pulumi.Output<string>;
  public readonly tableArn: pulumi.Output<string>;
  public readonly streamArn: pulumi.Output<string>;
  public readonly cmkArn: pulumi.Output<string>;

  constructor(name: string, args: AlertingTableArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingTable", args.env);
    super("boxalarm:data:AlertingTable", name, {}, opts);
    const { env } = args;

    const caller = aws.getCallerIdentityOutput({}, { parent: this });

    this.cmk = new aws.kms.Key(
      `${name}-cmk`,
      {
        description: `CMK for boxalarm-${env}-alerting-table`,
        enableKeyRotation: true,
        policy: caller.accountId.apply(dynamodbCmkPolicy),
      },
      { parent: this },
    );

    this.table = new aws.dynamodb.Table(
      `${name}-table`,
      {
        name: `boxalarm-${env}-alerting-table`,
        billingMode: "PAY_PER_REQUEST",
        hashKey: "pk",
        rangeKey: "sk",
        attributes: [
          { name: "pk", type: "S" },
          { name: "sk", type: "S" },
          { name: "gsi1pk", type: "S" },
          { name: "gsi1sk", type: "S" },
          { name: "gsi2pk", type: "S" },
          { name: "gsi2sk", type: "S" },
        ],
        globalSecondaryIndexes: [
          {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
          },
          {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
          },
        ],
        pointInTimeRecovery: { enabled: true },
        streamEnabled: true,
        // Alerting path: NEW_IMAGE only (not NEW_AND_OLD_IMAGES).
        streamViewType: "NEW_IMAGE",
        serverSideEncryption: {
          enabled: true,
          kmsKeyArn: this.cmk.arn,
        },
        ttl: {
          attributeName: "ttl",
          enabled: true,
        },
        // A replace-forcing schema change here is a total outage of the alert path,
        // which CLAUDE.md states may never happen. PITR alone doesn't guard against it.
        deletionProtectionEnabled: true,
      },
      // Belt-and-suspenders alongside deletionProtectionEnabled: also refuse an
      // outright pulumi destroy/replace of the table resource itself.
      { parent: this, protect: true },
    );

    this.tableName = this.table.name;
    this.tableArn = this.table.arn;
    this.streamArn = this.table.streamArn;
    this.cmkArn = this.cmk.arn;

    this.registerOutputs({
      tableName: this.tableName,
      tableArn: this.tableArn,
      streamArn: this.streamArn,
      cmkArn: this.cmkArn,
    });
  }
}
