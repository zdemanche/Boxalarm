import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";

export interface PlatformTableArgs {
  env: string;
}

/**
 * Deny UpdateItem/DeleteItem on audit partition keys (DEPT#*#AUDIT#*).
 * Attach to any role that may write the platform table so audit rows are append-only.
 */
export function auditMutationDenyStatement(tableArn: string): IamPolicyStatement {
  if (typeof tableArn !== "string" || tableArn.length === 0) {
    throw new Error(
      `auditMutationDenyStatement: tableArn is required (received ${JSON.stringify(tableArn)})`,
    );
  }

  return {
    Sid: "DenyAuditMutations",
    Effect: "Deny",
    // PutItem and BatchWriteItem must be denied alongside UpdateItem/DeleteItem:
    // PutItem on an existing pk/sk replaces the item wholesale, and BatchWriteItem
    // carries both put and delete semantics under its own action name. Denying only
    // Update/Delete leaves audit rows mutable via either of those two paths.
    Action: [
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:BatchWriteItem",
    ],
    Resource: tableArn,
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": ["DEPT#*#AUDIT#*"],
      },
    },
  };
}

/**
 * Platform-service DynamoDB table (E6-S1 / #84 table portion).
 * AWS-managed encryption (no customer CMK). On-demand, PITR + Streams, three GSIs.
 */
export class PlatformTable extends pulumi.ComponentResource {
  public readonly table: aws.dynamodb.Table;
  public readonly tableName: pulumi.Output<string>;
  public readonly tableArn: pulumi.Output<string>;
  public readonly streamArn: pulumi.Output<string>;

  constructor(name: string, args: PlatformTableArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PlatformTable", args.env);
    super("boxalarm:data:PlatformTable", name, {}, opts);
    const { env } = args;

    this.table = new aws.dynamodb.Table(
      `${name}-table`,
      {
        name: `boxalarm-${env}-platform-service`,
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
          { name: "gsi3pk", type: "S" },
          { name: "gsi3sk", type: "S" },
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
          {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
          },
        ],
        pointInTimeRecovery: { enabled: true },
        streamEnabled: true,
        streamViewType: "NEW_AND_OLD_IMAGES",
        // AWS-managed encryption for DynamoDB (enabled; no customer CMK).
        serverSideEncryption: { enabled: true },
        // PITR protects against in-window corruption, not against a replace-forcing
        // schema change (renamed GSI attribute, etc.) destroying the table outright.
        deletionProtectionEnabled: true,
      },
      { parent: this },
    );

    this.tableName = this.table.name;
    this.tableArn = this.table.arn;
    this.streamArn = this.table.streamArn;

    this.registerOutputs({
      tableName: this.tableName,
      tableArn: this.tableArn,
      streamArn: this.streamArn,
    });
  }
}
