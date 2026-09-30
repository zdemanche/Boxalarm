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

/**
 * Hosts that can never be a real deployed web origin: the reserved documentation/test TLDs
 * (RFC 2606/6761) and loopback. qa/staging/prod shipped with `https://*.boxalarm.example`,
 * which previews fine and then no one can sign in to the web app (deploy-readiness M4).
 */
export function isPlaceholderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    /(^|\.)(example|invalid|test|localhost|local)$/.test(host) ||
    /(^|\.)example\.(com|net|org)$/.test(host) ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  );
}

/** Problems with webOrigin's value (not its presence). dev may point at localhost. */
function webOriginProblems(env: string | undefined, webOrigin: string | undefined, stack: string) {
  if (webOrigin === undefined || webOrigin.trim() === "") {
    return [];
  }
  const fix = `pulumi config set webOrigin https://<real web host> --stack ${stack}`;
  let url: URL;
  try {
    url = new URL(webOrigin);
  } catch {
    return [`  - ${CONFIG_NAMESPACE}:webOrigin "${webOrigin}" is not a URL: ${fix}`];
  }
  if (url.protocol !== "https:") {
    return [
      `  - ${CONFIG_NAMESPACE}:webOrigin "${webOrigin}" must be https (Cognito callbacks): ${fix}`,
    ];
  }
  if (env !== "dev" && isPlaceholderHost(url.hostname)) {
    return [
      `  - ${CONFIG_NAMESPACE}:webOrigin "${webOrigin}" is a placeholder host; outside dev it must ` +
        `be the real web origin, or Cognito sign-in and assets CORS cannot work: ${fix}`,
    ];
  }
  return [];
}

function setCommand(k: RequiredConfigKey, stack: string): string {
  return `pulumi config set ${k.secret ? "--secret " : ""}${k.key} ${k.example} --stack ${stack}`;
}

/** Every problem with the stack config, one line each. Empty when the stack can deploy. */
export function stackConfigProblems(read: ConfigReader, stack: string): string[] {
  const ctx: StackConfigContext = {
    env: read("env"),
    canaryEnabled: read("canaryEnabled") === "true",
  };
  const missing = REQUIRED_CONFIG.filter((k) => (k.when ? k.when(ctx) : true))
    .filter((k) => {
      const value = read(k.key);
      return value === undefined || value.trim() === "";
    })
    .map((k) => `  - ${CONFIG_NAMESPACE}:${k.key} (${k.why}): ${setCommand(k, stack)}`);
  return [...missing, ...webOriginProblems(ctx.env, read("webOrigin"), stack)];
}

/** Throws one error naming every problem, or returns quietly. */
export function validateStackConfig(read: ConfigReader, stack: string): void {
  const problems = stackConfigProblems(read, stack);
  if (problems.length > 0) {
    throw new Error(
      `Stack "${stack}" has ${problems.length} configuration problem(s): missing or invalid ` +
        `values. Fix all of them, then preview again (docs/runbooks/first-deploy.md):\n` +
        problems.join("\n"),
    );
  }
}
