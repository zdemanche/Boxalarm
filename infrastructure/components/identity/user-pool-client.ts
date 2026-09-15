import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { clientWriteAttributes } from "./write-attributes";

export interface BoxalarmUserPoolClientArgs {
  userPoolId: pulumi.Input<string>;
  clientName: string;
  standardWriteAttributes: readonly string[];
  /** OAuth callback URLs (mobile: boxalarm://auth; web: derived from webOrigin). */
  callbackUrls: string[];
  /** OAuth logout URLs (mobile: boxalarm://auth; web: derived from webOrigin). */
  logoutUrls: string[];
  /** Optional Cognito explicit auth flows (SRP, refresh, etc.). */
  explicitAuthFlows?: string[];
  /**
   * Always false — public clients only (no client secret). Typed as `false` so
   * callers cannot opt into a confidential client here.
   */
  generateSecret?: false;
  /** Token revocation can be enabled later (E8 follow-up / #86). */
  enableTokenRevocation?: boolean;
}

// boxalarm-docs#115 / E8-S1-INFRA #6: every app client (mobile, web) must go through
// this component rather than instantiating aws.cognito.UserPoolClient directly, so
// custom:deptId self-service write access is structurally impossible, and OAuth+PKCE
// (no client secret) is applied uniformly.
export class BoxalarmUserPoolClient extends pulumi.ComponentResource {
  public readonly userPoolClient: aws.cognito.UserPoolClient;

  constructor(
    name: string,
    args: BoxalarmUserPoolClientArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    // Validate before super() so a bad attrs list never leaves a half-registered
    // ComponentResource whose registerOutputs can race the next test's mocks.
    const writeAttributes = clientWriteAttributes(args.standardWriteAttributes);
    if (!Array.isArray(args.callbackUrls) || args.callbackUrls.length === 0) {
      throw new Error(`BoxalarmUserPoolClient: callbackUrls is required`);
    }
    if (!Array.isArray(args.logoutUrls) || args.logoutUrls.length === 0) {
      throw new Error(`BoxalarmUserPoolClient: logoutUrls is required`);
    }

    super("boxalarm:identity:UserPoolClient", name, {}, opts);

    this.userPoolClient = new aws.cognito.UserPoolClient(
      `${name}-client`,
      {
        name: args.clientName,
        userPoolId: args.userPoolId,
        writeAttributes,
        generateSecret: false,
        allowedOauthFlowsUserPoolClient: true,
        allowedOauthFlows: ["code"],
        allowedOauthScopes: ["openid", "profile", "email"],
        callbackUrls: args.callbackUrls,
        logoutUrls: args.logoutUrls,
        supportedIdentityProviders: ["COGNITO"],
        preventUserExistenceErrors: "ENABLED",
        ...(args.explicitAuthFlows !== undefined
          ? { explicitAuthFlows: args.explicitAuthFlows }
          : {}),
        ...(args.enableTokenRevocation !== undefined
          ? { enableTokenRevocation: args.enableTokenRevocation }
          : {}),
      },
      { parent: this },
    );

    this.registerOutputs({ userPoolClient: this.userPoolClient });
  }
}
