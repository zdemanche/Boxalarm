/**
 * Up-front validation of the `boxalarm-infra:*` stack config (deploy-readiness C2).
 *
 * Each component reads its own keys with `config.require*`, which fails preview on the FIRST
 * missing key only, so a fresh stack took one preview per key to discover what it needed.
 * index.ts calls validateStackConfig before building anything: every missing or invalid key
 * is reported in one error, each with the command that sets it (`--secret` for secrets).
 */

export const CONFIG_NAMESPACE = "boxalarm-infra";

export interface RequiredConfigKey {
  key: string;
  /** Set with `pulumi config set --secret`: never committed in Pulumi.<stack>.yaml. */
  secret: boolean;
  /** Example value for the error message (never a real secret). */
  example: string;
  /** Why the stack needs it. */
  why: string;
  /** Required only when this returns true (default: always). */
  when?: (ctx: StackConfigContext) => boolean;
}

export interface StackConfigContext {
  env: string | undefined;
  /** True when `boxalarm-infra:canaryEnabled` is `true`. */
  canaryEnabled: boolean;
}

/** Reads a key as index.ts's Config would; secrets included. undefined = not set. */
export type ConfigReader = (key: string) => string | undefined;

export const REQUIRED_CONFIG: readonly RequiredConfigKey[] = [
  {
    key: "env",
    secret: false,
    example: "dev",
    why: "the stack's environment (dev|qa|staging|prod)",
  },
  {
    key: "webOrigin",
    secret: false,
    example: "https://app.<dept-domain>",
    why: "the web app origin (Cognito callback/logout URLs, assets bucket CORS)",
  },
  {
    key: "deptId",
    secret: false,
    example: "nichols-fd",
    why: "the department every scanner, canary and staleness check runs for",
  },
  {
    key: "nerisSchemaSourceUrl",
    secret: false,
    example: "https://<schema-pipeline-host>/neris/schema.json",
    why: "where the daily NERIS schema refresh fetches from",
  },
  {
    key: "notificationSesFromAddress",
    secret: false,
    example: "notifications@<ses-verified-domain>",
    why: "the SES-verified sender of notification digests",
  },
  {
    key: "smsWebhookSecret",
    secret: true,
    example: '"$(openssl rand -hex 32)"',
    why: "shared secret the SMS delivery-receipt webhook verifies",
  },
  {
    key: "voiceWebhookSecret",
    secret: true,
    example: '"$(openssl rand -hex 32)"',
    why: "shared secret the voice delivery-receipt webhook verifies",
  },
  {
    key: "pushWebhookSecret",
    secret: true,
    example: '"$(openssl rand -hex 32)"',
    why: "shared secret the push delivery-receipt webhook verifies",
  },
  {
    key: "canaryMemberId",
    secret: true,
    example: "<memberId of the canary device's member>",
    why: "the member the production canary pages every tick",
    when: (ctx) => ctx.canaryEnabled,
  },
  {
    key: "alertingPageEmail",
    secret: false,
    example: "oncall@<dept-domain>",
    why: "who alerting-page (every alert-path alarm) emails",
    when: (ctx) => ctx.env === "prod",
  },
  {
    key: "chiefNotificationEmail",
    secret: false,
    example: "chief@<dept-domain>",
    why: "who chief-notifications (ops alarms, export/disposal notices) emails",
    when: (ctx) => ctx.env === "prod",
  },
];

function setCommand(k: RequiredConfigKey, stack: string): string {
  return `pulumi config set ${k.secret ? "--secret " : ""}${k.key} ${k.example} --stack ${stack}`;
}

/** Every problem with the stack config, one line each. Empty when the stack can deploy. */
export function stackConfigProblems(read: ConfigReader, stack: string): string[] {
  const ctx: StackConfigContext = {
    env: read("env"),
    canaryEnabled: read("canaryEnabled") === "true",
  };
  return REQUIRED_CONFIG.filter((k) => (k.when ? k.when(ctx) : true))
    .filter((k) => {
      const value = read(k.key);
      return value === undefined || value.trim() === "";
    })
    .map((k) => `  - ${CONFIG_NAMESPACE}:${k.key} (${k.why}): ${setCommand(k, stack)}`);
}

/** Throws one error naming every problem, or returns quietly. */
export function validateStackConfig(read: ConfigReader, stack: string): void {
  const problems = stackConfigProblems(read, stack);
  if (problems.length > 0) {
    throw new Error(
      `Stack "${stack}" is missing ${problems.length} required configuration value(s). ` +
        `Set all of them, then preview again (docs/runbooks/first-deploy.md):\n` +
        problems.join("\n"),
    );
  }
}
