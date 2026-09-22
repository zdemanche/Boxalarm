import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { IamPolicyStatement } from "../observability/observability-policy";

/** Documented NERIS non-prod API host (N6.4 — never used from prod). */
export const NERIS_DEV_BASE_URL = "https://api-test.neris.fsri.org";
/** Documented NERIS production API host. */
export const NERIS_PROD_BASE_URL = "https://api.neris.fsri.org";

const KNOWN_ENVS = new Set(["dev", "qa", "staging", "prod"]);
const NON_PROD_ENVS = new Set(["dev", "qa", "staging"]);

export interface NerisConfigArgs {
  env: string;
}

export function nerisBaseUrlForEnv(env: string): string {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error(`nerisBaseUrlForEnv: env is required (received ${JSON.stringify(env)})`);
  }
  if (!KNOWN_ENVS.has(env)) {
    throw new Error(`nerisBaseUrlForEnv: unknown env "${env}"`);
  }
  // Hardcoded by env so non-prod cannot be misconfigured to hit the prod host (N6.4).
  if (env === "prod") {
    return NERIS_PROD_BASE_URL;
  }
  return NERIS_DEV_BASE_URL;
}

export function nerisUserAgentForEnv(env: string): string {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error(`nerisUserAgentForEnv: env is required (received ${JSON.stringify(env)})`);
  }
  if (!KNOWN_ENVS.has(env)) {
    throw new Error(`nerisUserAgentForEnv: unknown env "${env}"`);
  }
  return `Boxalarm/${env}`;
}

/**
 * IAM statements for a Lambda (or other principal) that calls NERIS: read the
 * OAuth client secret and the per-env base-url / user-agent SSM parameters.
 */
export function nerisClientPolicyStatements(
  secretArn: string,
  env: string,
): IamPolicyStatement[] {
  if (typeof secretArn !== "string" || secretArn.length === 0) {
    throw new Error(
      `nerisClientPolicyStatements: secretArn is required (received ${JSON.stringify(secretArn)})`,
    );
  }
  if (!KNOWN_ENVS.has(env)) {
    throw new Error(`nerisClientPolicyStatements: unknown env "${env}"`);
  }

  return [
    {
      Sid: "NerisGetSecretValue",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: secretArn,
    },
    {
      Sid: "NerisGetParameters",
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:GetParameters"],
      Resource: `arn:aws:ssm:*:*:parameter/boxalarm/${env}/neris/*`,
    },
  ];
}

/**
 * Per-environment NERIS integration config (E6-S7-INFRA).
 * OAuth client credentials live in Secrets Manager — the Secret shell is managed
 * here, but **no SecretVersion**: values are set out-of-band. Managing a
 * placeholder SecretVersion would wipe operator-set credentials on every
 * `pulumi up`. Base URL is hardcoded from env so non-prod cannot point at prod.
 */
export class NerisConfig extends pulumi.ComponentResource {
  public readonly secret: aws.secretsmanager.Secret;
  public readonly baseUrlParameter: aws.ssm.Parameter;
  public readonly userAgentParameter: aws.ssm.Parameter;
  public readonly baseUrl: string;
  public readonly userAgent: string;

  constructor(name: string, args: NerisConfigArgs, opts?: pulumi.ComponentResourceOptions) {
    if (typeof args.env !== "string" || args.env.length === 0) {
      throw new Error(`NerisConfig: env is required (received ${JSON.stringify(args.env)})`);
    }
    if (!KNOWN_ENVS.has(args.env)) {
      throw new Error(`NerisConfig: unknown env "${args.env}"`);
    }

    super("boxalarm:neris:NerisConfig", name, {}, opts);
    const { env } = args;

    this.baseUrl = nerisBaseUrlForEnv(env);
    this.userAgent = nerisUserAgentForEnv(env);

    // Defense in depth: even if nerisBaseUrlForEnv is wrong, refuse to ship
    // the prod host into a non-prod stack.
    if (NON_PROD_ENVS.has(env) && this.baseUrl === NERIS_PROD_BASE_URL) {
      throw new Error(`NerisConfig: non-prod env "${env}" must not use NERIS_PROD_BASE_URL (N6.4)`);
    }

    this.secret = new aws.secretsmanager.Secret(
      `${name}-credentials`,
      {
        name: `boxalarm-${env}-neris-client-credentials`,
        description: `NERIS OAuth client credentials for ${env} (values set out-of-band; no Pulumi SecretVersion)`,
      },
      { parent: this },
    );

    this.baseUrlParameter = new aws.ssm.Parameter(
      `${name}-base-url`,
      {
        name: `/boxalarm/${env}/neris/base-url`,
        type: "String",
        value: this.baseUrl,
        description: `NERIS API base URL for ${env}`,
      },
      { parent: this },
    );

    this.userAgentParameter = new aws.ssm.Parameter(
      `${name}-user-agent`,
      {
        name: `/boxalarm/${env}/neris/user-agent`,
        type: "String",
        value: this.userAgent,
        description: `Distinct NERIS User-Agent for ${env} (N6.4)`,
      },
      { parent: this },
    );

    this.registerOutputs({
      secretArn: this.secret.arn,
      baseUrl: this.baseUrl,
      userAgent: this.userAgent,
    });
  }
}
