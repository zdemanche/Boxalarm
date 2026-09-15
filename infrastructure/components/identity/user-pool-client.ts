import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { clientWriteAttributes } from "./write-attributes";

export interface BoxalarmUserPoolClientArgs {
  userPoolId: pulumi.Input<string>;
  clientName: string;
  standardWriteAttributes: readonly string[];
}

// boxalarm-docs#115: every app client (mobile, web) must go through this component
// rather than instantiating aws.cognito.UserPoolClient directly, so custom:deptId
// self-service write access is structurally impossible to reintroduce later.
export class BoxalarmUserPoolClient extends pulumi.ComponentResource {
  public readonly userPoolClient: aws.cognito.UserPoolClient;

  constructor(
    name: string,
    args: BoxalarmUserPoolClientArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("boxalarm:identity:UserPoolClient", name, {}, opts);

    this.userPoolClient = new aws.cognito.UserPoolClient(
      `${name}-client`,
      {
        name: args.clientName,
        userPoolId: args.userPoolId,
        writeAttributes: clientWriteAttributes(args.standardWriteAttributes),
      },
      { parent: this },
    );

    this.registerOutputs({ userPoolClient: this.userPoolClient });
  }
}
