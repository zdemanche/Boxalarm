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
  /**
   * Cognito explicit auth flows (SRP, refresh, etc.). Defaults to
   * ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"] when omitted — this component's
   * contract is that OAuth+PKCE is applied uniformly, so the default must not fall
   * back to Cognito's own (unreviewed) defaults.
   */
  explicitAuthFlows?: string[];
  /**
   * Always false — public clients only (no client secret). Typed as `false` so
   * callers cannot opt into a confidential client here.
   */
  generateSecret?: false;
  /** Token revocation can be enabled later (E8 follow-up / #86). */
  enableTokenRevocation?: boolean;
  /**
   * E8-S8-INFRA #259: 1h/1h/3650d on both clients, no asymmetry, revocation is
   * the only control that ends a session (OQ-24). Rotation grace period is
   * seconds, capped at 60 by the provider.
   */
  accessTokenValidityHours?: number;
  idTokenValidityHours?: number;
  refreshTokenValidityDays?: number;
  refreshTokenRotationGraceSeconds?: number;
}

// #180 / E8-S1-INFRA #6: every app client (mobile, web) must go through
// this component rather than instantiating aws.cognito.UserPoolClient directly, so
// custom:deptId self-service write access is structurally impossible, and OAuth+PKCE
// (no client secret) is applied uniformly.
const DEFAULT_EXPLICIT_AUTH_FLOWS = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"];

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
        explicitAuthFlows: args.explicitAuthFlows ?? DEFAULT_EXPLICIT_AUTH_FLOWS,
        ...(args.enableTokenRevocation !== undefined
          ? { enableTokenRevocation: args.enableTokenRevocation }
          : {}),
        ...(args.accessTokenValidityHours !== undefined ||
        args.idTokenValidityHours !== undefined ||
        args.refreshTokenValidityDays !== undefined
          ? {
              accessTokenValidity: args.accessTokenValidityHours,
              idTokenValidity: args.idTokenValidityHours,
              refreshTokenValidity: args.refreshTokenValidityDays,
              tokenValidityUnits: { accessToken: "hours", idToken: "hours", refreshToken: "days" },
            }
          : {}),
        ...(args.refreshTokenRotationGraceSeconds !== undefined
          ? {
              refreshTokenRotation: {
                feature: "ENABLED",
                retryGracePeriodSeconds: args.refreshTokenRotationGraceSeconds,
              },
            }
          : {}),
      },
      { parent: this },
    );

    this.registerOutputs({ userPoolClient: this.userPoolClient });
  }
}
