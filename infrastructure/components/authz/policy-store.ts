import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export interface PolicyStoreArgs {
  env: string;
}

/**
 * Cedar policy store for AWS Verified Permissions (E8-S3-INFRA). Pinned contract:
 * downstream alerting/personnel routes read `policyStore.policyStoreId`.
 */
export class PolicyStore extends pulumi.ComponentResource {
  public readonly store: aws.verifiedpermissions.PolicyStore;
  public readonly policyStoreId: pulumi.Output<string>;
  public readonly arn: pulumi.Output<string>;

  constructor(name: string, args: PolicyStoreArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PolicyStore", args.env);
    super("boxalarm:authz:PolicyStore", name, {}, opts);

    this.store = new aws.verifiedpermissions.PolicyStore(
      `${name}-store`,
      {
        validationSettings: { mode: "OFF" },
        description: `Boxalarm ${args.env} Cedar policy store`,
      },
      { parent: this },
    );

    this.policyStoreId = this.store.id;
    this.arn = this.store.arn;

    this.registerOutputs({ policyStoreId: this.policyStoreId, arn: this.arn });
  }
}

const env = new pulumi.Config("boxalarm-infra").require("env");
export const policyStore = new PolicyStore("policy-store", { env });
