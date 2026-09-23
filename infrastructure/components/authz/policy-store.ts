import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { ROLE_GROUPS, CEDAR_SCHEMA, adminActionsPolicy, viewConfigPolicy } from "./cedar-policies";

export interface PolicyStoreArgs {
  env: string;
  userPoolId: pulumi.Input<string>;
  userPoolArn: pulumi.Input<string>;
  allowedClientIds: pulumi.Input<string>[];
}

/** IAM for a LOB service Lambda calling Verified Permissions via @boxalarm/authz. */
export function verifiedPermissionsPolicyStatement(policyStoreArn: string): IamPolicyStatement {
  if (typeof policyStoreArn !== "string" || policyStoreArn.length === 0) {
    throw new Error(
      `verifiedPermissionsPolicyStatement: policyStoreArn is required (received ${JSON.stringify(policyStoreArn)})`,
    );
  }
  return {
    Sid: "AuthorizeWithVerifiedPermissions",
    Effect: "Allow",
    Action: [
      "verifiedpermissions:IsAuthorizedWithToken",
      "verifiedpermissions:BatchIsAuthorizedWithToken",
    ],
    Resource: policyStoreArn,
  };
}

/**
 * Verified Permissions policy store (E8-S3-INFRA #255): Cedar schema, the six
 * role groups as Cognito UserPoolGroups, and the department-scoped, no-default-allow
 * policies (AC1, AC3, AC5). One store per env — every LOB service shares it.
 */
export class PolicyStore extends pulumi.ComponentResource {
  public readonly policyStore: aws.verifiedpermissions.PolicyStore;
  public readonly policyStoreId: pulumi.Output<string>;
  public readonly policyStoreArn: pulumi.Output<string>;
  public readonly schema: aws.verifiedpermissions.Schema;
  public readonly identitySource: aws.verifiedpermissions.IdentitySource;
  public readonly roleGroups: aws.cognito.UserGroup[];
  public readonly adminActionsPolicy: aws.verifiedpermissions.Policy;
  public readonly viewConfigPolicy: aws.verifiedpermissions.Policy;

  constructor(name: string, args: PolicyStoreArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PolicyStore", args.env);
    super("boxalarm:authz:PolicyStore", name, {}, opts);
    const { env } = args;

    this.policyStore = new aws.verifiedpermissions.PolicyStore(
      `${name}-store`,
      {
        description: `boxalarm-${env} Cedar policy store`,
        deletionProtection: "ENABLED",
        validationSettings: { mode: "STRICT" },
      },
      { parent: this, protect: true },
    );

    this.policyStoreId = this.policyStore.policyStoreId;
    this.policyStoreArn = this.policyStore.arn;

    this.schema = new aws.verifiedpermissions.Schema(
      `${name}-schema`,
      { policyStoreId: this.policyStoreId, definition: { value: CEDAR_SCHEMA } },
      { parent: this },
    );

    this.identitySource = new aws.verifiedpermissions.IdentitySource(
      `${name}-identity-source`,
      {
        policyStoreId: this.policyStoreId,
        configuration: {
          cognitoUserPoolConfiguration: {
            userPoolArn: args.userPoolArn,
            clientIds: args.allowedClientIds,
            groupConfiguration: { groupEntityType: "Boxalarm::UserGroup" },
          },
        },
      },
      { parent: this, dependsOn: [this.schema] },
    );

    this.roleGroups = ROLE_GROUPS.map(
      (role) =>
        new aws.cognito.UserGroup(
          `${name}-group-${role.toLowerCase()}`,
          { name: role, userPoolId: args.userPoolId },
          { parent: this },
        ),
    );

    // AC4: no permit-all/default-allow policy exists — only these two,
    // department-scoped, role-gated statements.
    this.adminActionsPolicy = new aws.verifiedpermissions.Policy(
      `${name}-admin-actions`,
      {
        policyStoreId: this.policyStoreId,
        definition: { static: { statement: adminActionsPolicy() } },
      },
      { parent: this, dependsOn: [this.schema] },
    );

    this.viewConfigPolicy = new aws.verifiedpermissions.Policy(
      `${name}-view-config`,
      {
        policyStoreId: this.policyStoreId,
        definition: { static: { statement: viewConfigPolicy() } },
      },
      { parent: this, dependsOn: [this.schema] },
    );

    this.registerOutputs({
      policyStoreId: this.policyStoreId,
      policyStoreArn: this.policyStoreArn,
    });
  }
}
