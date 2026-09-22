import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { dynamodbCmkPolicy } from "./cmk-policy";

const KNOWN_ENVS = new Set(["dev", "qa", "staging", "prod"]);

export interface IncidentTableArgs {
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
 * Incident-service DynamoDB table (E6-S1-INFRA).
 * Customer-managed KMS, on-demand, PITR + Streams from day one.
 * GSI1 supports queries by DEPT#{deptId} / INCIDENT#{alarmAt}.
 */
export class IncidentTable extends pulumi.ComponentResource {
  public readonly table: aws.dynamodb.Table;
  public readonly cmk: aws.kms.Key;
  public readonly tableName: pulumi.Output<string>;
  public readonly tableArn: pulumi.Output<string>;
  public readonly streamArn: pulumi.Output<string>;
  public readonly cmkArn: pulumi.Output<string>;

  constructor(name: string, args: IncidentTableArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("IncidentTable", args.env);
    super("boxalarm:data:IncidentTable", name, {}, opts);
    const { env } = args;

    const caller = aws.getCallerIdentityOutput({}, { parent: this });

    this.cmk = new aws.kms.Key(
      `${name}-cmk`,
      {
        description: `CMK for boxalarm-${env}-incident-service`,
        enableKeyRotation: true,
        policy: caller.accountId.apply(dynamodbCmkPolicy),
      },
      { parent: this },
    );

    this.table = new aws.dynamodb.Table(
      `${name}-table`,
      {
        name: `boxalarm-${env}-incident-service`,
        billingMode: "PAY_PER_REQUEST",
        hashKey: "pk",
        rangeKey: "sk",
        attributes: [
          { name: "pk", type: "S" },
          { name: "sk", type: "S" },
          { name: "gsi1pk", type: "S" },
          { name: "gsi1sk", type: "S" },
        ],
        globalSecondaryIndexes: [
          {
            name: "GSI1",
            // Application keys: gsi1pk = DEPT#{deptId}, gsi1sk = INCIDENT#{alarmAt}
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
          },
        ],
        pointInTimeRecovery: { enabled: true },
        streamEnabled: true,
        streamViewType: "NEW_AND_OLD_IMAGES",
        serverSideEncryption: {
          enabled: true,
          kmsKeyArn: this.cmk.arn,
        },
        // A replace-forcing schema change here is a total outage of incident data.
        // PITR alone doesn't guard against it.
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
