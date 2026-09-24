import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";

export interface PlatformTableArgs {
  env: string;
}

/**
 * Deny UpdateItem/DeleteItem/BatchWriteItem on audit partition keys
 * (DEPT#*#AUDIT#*). Attach to any role that may write the platform table so an
 * existing audit row can never be mutated or removed once written.
 *
 * PutItem is deliberately NOT denied here. Every legitimate writer of an
 * AUDIT_LOG_ENTRY — updateStatus's transaction (memberRepository.ts), createMember,
 * the export handler, retention disposal's own audit write — creates its audit row
 * with a fresh, timestamp-suffixed sort key via PutItem as part of its own
 * transaction; that is the only way audit rows are ever written (there is no
 * separate audit-writer service, and no outbox-relay path for them yet). Denying
 * PutItem blocked those legitimate inserts outright (member status changes could
 * never complete, so the personnel.member.updated event that feeds session
 * revocation was never emitted; retention disposal could never record what it
 * destroyed). BatchWriteItem is still denied even though nothing here uses it: it
 * carries delete semantics under its own action name, so leaving it un-denied would
 * reopen a mutation path this statement exists to close, at no cost since no writer
 * needs it.
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
    Action: ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
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
