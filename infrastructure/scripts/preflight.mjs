#!/usr/bin/env node
// Account preflight for a Boxalarm stack - run BEFORE the first `pulumi up` into an account
// (docs/runbooks/first-deploy.md, step 0). Read-only: it only describes the account.
//
// Checks (deploy-readiness C3, M6):
//   1. Lambda concurrent-executions quota >= 1,000. A fresh account starts at 10, and every
//      stack reserves STACK_RESERVED_CONCURRENCY across its functions; at 10 the first
//      reservation fails `pulumi up` ("decreases account's UnreservedConcurrentExecution below
//      its minimum"). With --first-deploy it also checks this stack's reservations fit while
//      leaving AWS's 100 unreserved.
//   2. CloudTrail trails in the region: each stack creates TRAILS_PER_STACK, and the region
//      limit is 5 (multi-region trails from elsewhere count too).
//   3. Account strategy: one AWS account per stack, prod in its own. A Boxalarm trail from
//      another stack in this account fails the run for prod, and warns otherwise.
//
// Usage: node scripts/preflight.mjs <dev|qa|staging|prod> [--region us-east-1] [--first-deploy]
// Uses the default AWS credential chain. Exit 0 = ready, 1 = not ready, 2 = usage.
import { pathToFileURL } from "node:url";
import { LambdaClient, GetAccountSettingsCommand } from "@aws-sdk/client-lambda";
import { CloudTrailClient, DescribeTrailsCommand } from "@aws-sdk/client-cloudtrail";

export const MIN_ACCOUNT_CONCURRENCY = 1000;
/** AWS keeps at least this much concurrency unreserved in every account. */
export const MIN_UNRESERVED_CONCURRENCY = 100;
/**
 * Sum of reservedConcurrentExecutions across one stack's functions. Kept in step with the
 * code by test/scripts/preflight.test.ts, which sums the full stack under Pulumi mocks.
 */
export const STACK_RESERVED_CONCURRENCY = 216;
export const TRAIL_LIMIT_PER_REGION = 5;
export const TRAILS_PER_STACK = 2;
const STACK_TRAIL =
  /^boxalarm-(dev|qa|staging|prod)-(cognito-management-events|alerting-data-events)$/;

/**
 * @param {{ lambda: { send: Function }, cloudtrail: { send: Function } }} clients
 * @param {{ env: string, firstDeploy?: boolean }} options
 * @returns {Promise<{ failures: string[], warnings: string[], info: string[] }>}
 */
export async function runPreflight(clients, { env, firstDeploy = false }) {
  const failures = [];
  const warnings = [];
  const info = [];

  const settings = await clients.lambda.send(new GetAccountSettingsCommand({}));
  const limit = settings.AccountLimit?.ConcurrentExecutions ?? 0;
  const unreserved = settings.AccountLimit?.UnreservedConcurrentExecutions ?? 0;
  info.push(`Lambda concurrency: quota ${limit}, unreserved ${unreserved}.`);
  if (limit < MIN_ACCOUNT_CONCURRENCY) {
    failures.push(
      `Lambda concurrent-executions quota is ${limit}; Boxalarm needs at least ` +
        `${MIN_ACCOUNT_CONCURRENCY} (this stack alone reserves ${STACK_RESERVED_CONCURRENCY}, and ` +
        `AWS keeps ${MIN_UNRESERVED_CONCURRENCY} unreserved). Request an increase in Service ` +
        `Quotas (AWS Lambda > Concurrent executions, quota L-B99A9384) and wait for approval ` +
        `before the first deploy.`,
    );
  }
  if (firstDeploy && unreserved - STACK_RESERVED_CONCURRENCY < MIN_UNRESERVED_CONCURRENCY) {
    failures.push(
      `Only ${unreserved} concurrency is unreserved; this stack reserves ` +
        `${STACK_RESERVED_CONCURRENCY} and AWS must keep ${MIN_UNRESERVED_CONCURRENCY} free, so ` +
        `\`pulumi up\` would fail. Raise the quota or free reservations in this account.`,
    );
  }

  const { trailList = [] } = await clients.cloudtrail.send(
    new DescribeTrailsCommand({ includeShadowTrails: true }),
  );
  const names = trailList.map((t) => t.Name ?? "");
  const ownTrails = names.filter((n) => STACK_TRAIL.exec(n)?.[1] === env);
  const counted = names.length - ownTrails.length;
  info.push(
    `CloudTrail: ${names.length} trail(s) in the region, ${ownTrails.length} this stack's.`,
  );
  if (counted + TRAILS_PER_STACK > TRAIL_LIMIT_PER_REGION) {
    failures.push(
      `${counted} other CloudTrail trail(s) already apply to this region and the stack adds ` +
        `${TRAILS_PER_STACK}; the limit is ${TRAIL_LIMIT_PER_REGION} per region. Deploy this ` +
        `stack into its own account (one account per stack), or remove unused trails.`,
    );
  }

  const otherStacks = [
    ...new Set(
      names
        .map((n) => STACK_TRAIL.exec(n)?.[1])
        .filter((other) => other !== undefined && other !== env),
    ),
  ];
  if (otherStacks.length > 0) {
    const message =
      `This account already holds Boxalarm stack(s) ${otherStacks.join(", ")}. The account ` +
      `strategy is one AWS account per stack, with prod in its own: stacks sharing an account ` +
      `share its Lambda concurrency, IAM role and trail quotas, and a dev mistake can reach prod.`;
    if (env === "prod" || otherStacks.includes("prod")) {
      failures.push(message);
    } else {
      warnings.push(message);
    }
  }

  return { failures, warnings, info };
}

function parseArgs(argv) {
  const [env, ...rest] = argv;
  if (!["dev", "qa", "staging", "prod"].includes(env ?? "")) {
    return undefined;
  }
  let region = process.env.AWS_REGION ?? "us-east-1";
  let firstDeploy = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--region" && rest[i + 1]) {
      region = rest[(i += 1)];
    } else if (rest[i] === "--first-deploy") {
      firstDeploy = true;
    } else {
      return undefined;
    }
  }
  return { env, region, firstDeploy };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "usage: node scripts/preflight.mjs <dev|qa|staging|prod> [--region us-east-1] [--first-deploy]",
    );
    process.exit(2);
  }
  const clients = {
    lambda: new LambdaClient({ region: args.region }),
    cloudtrail: new CloudTrailClient({ region: args.region }),
  };
  const { failures, warnings, info } = await runPreflight(clients, args);
  for (const line of info) console.log(line);
  for (const line of warnings) console.warn(`WARNING: ${line}`);
  for (const line of failures) console.error(`NOT READY: ${line}`);
  if (failures.length > 0) {
    console.error(
      `preflight failed for ${args.env} in ${args.region}: fix the above, then re-run.`,
    );
    process.exit(1);
  }
  console.log(`preflight passed for ${args.env} in ${args.region}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`preflight could not read the account: ${error?.message ?? error}`);
    process.exit(1);
  });
}
