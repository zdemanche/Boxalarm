import * as path from "path";
import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resourcesOfType, settleStack } from "../alerting/mock-harness";

/**
 * scripts/preflight.mjs against mocked AWS SDK clients (deploy-readiness C3/M6). It is never
 * run against AWS here.
 */
interface PreflightResult {
  failures: string[];
  warnings: string[];
  info: string[];
}
interface PreflightModule {
  runPreflight(
    clients: { lambda: { send: Send }; cloudtrail: { send: Send }; sts: { send: Send } },
    options: { env: string; region: string; firstDeploy?: boolean },
  ): Promise<PreflightResult>;
  STACK_RESERVED_CONCURRENCY: number;
}
type Send = (command: { constructor: { name: string } }) => Promise<unknown>;

const SCRIPT = path.resolve(__dirname, "../../scripts/preflight.mjs");
const load = async () => (await import(SCRIPT)) as PreflightModule;

const ACCOUNT = "111122223333";
type Trail = { Name: string; TrailARN: string; HomeRegion: string; IsMultiRegionTrail?: boolean };
/** A trail as DescribeTrails lists it; by default owned by this account, homed in us-east-1. */
const trail = (
  name: string,
  { account = ACCOUNT, home = "us-east-1", multiRegion = false } = {},
): Trail => ({
  Name: name,
  TrailARN: `arn:aws:cloudtrail:${home}:${account}:trail/${name}`,
  HomeRegion: home,
  IsMultiRegionTrail: multiRegion,
});

function account({
  limit = 1000,
  unreserved = 1000,
  trails = [] as (string | Trail)[],
}: { limit?: number; unreserved?: number; trails?: (string | Trail)[] } = {}) {
  const calls: string[] = [];
  const send: Send = async (command) => {
    calls.push(command.constructor.name);
    switch (command.constructor.name) {
      case "GetAccountSettingsCommand":
        return {
          AccountLimit: { ConcurrentExecutions: limit, UnreservedConcurrentExecutions: unreserved },
        };
      case "DescribeTrailsCommand":
        return { trailList: trails.map((t) => (typeof t === "string" ? trail(t) : t)) };
      case "GetCallerIdentityCommand":
        return { Account: ACCOUNT };
      default:
        throw new Error(`unexpected call ${command.constructor.name}`);
    }
  };
  return { clients: { lambda: { send }, cloudtrail: { send }, sts: { send } }, calls };
}

describe("preflight.mjs", () => {
  it("fails a fresh account (Lambda concurrency quota 10) with the quota to request", async () => {
    const { runPreflight } = await load();
    const { failures } = await runPreflight(account({ limit: 10, unreserved: 10 }).clients, {
      env: "dev",
      region: "us-east-1",
    });
    expect(failures.join("\n")).toMatch(/quota is 10; Boxalarm needs at least 1000/);
    expect(failures.join("\n")).toContain("L-B99A9384");
  });

  it("passes an account with a 1,000 quota and no other trails, reading only", async () => {
    const { runPreflight } = await load();
    const { clients, calls } = account();
    const result = await runPreflight(clients, {
      env: "dev",
      region: "us-east-1",
      firstDeploy: true,
    });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(calls.sort()).toEqual([
      "DescribeTrailsCommand",
      "GetAccountSettingsCommand",
      "GetCallerIdentityCommand",
    ]);
  });

  it("fails when the stack's 2 trails would exceed the 5-per-region limit", async () => {
    const { runPreflight } = await load();
    const { failures } = await runPreflight(
      account({ trails: ["org-trail", "security", "legacy-a", "legacy-b"] }).clients,
      { env: "dev", region: "us-east-1" },
    );
    expect(failures.join("\n")).toMatch(/4 other CloudTrail trail\(s\).*limit is 5/);
  });

  it("does not count organization trails owned by another account (review F8)", async () => {
    const { runPreflight } = await load();
    const orgTrail = trail("org-management-trail", { account: "999988887777", multiRegion: true });
    const { failures, info } = await runPreflight(
      account({ trails: ["security", "legacy-a", "legacy-b", orgTrail] }).clients,
      { env: "dev", region: "us-east-1" },
    );
    expect(failures).toEqual([]);
    expect(info.join("\n")).toContain("1 other-account (organization) trail(s) not counted");
  });

  it("counts this account's multi-region trails homed elsewhere, but not single-region ones", async () => {
    const { runPreflight } = await load();
    const elsewhere = (name: string, multiRegion: boolean) =>
      trail(name, { home: "us-west-2", multiRegion });
    const tooMany = await runPreflight(
      account({
        trails: ["a", "b", elsewhere("west-multi-1", true), elsewhere("west-multi-2", true)],
      }).clients,
      { env: "dev", region: "us-east-1" },
    );
    expect(tooMany.failures.join("\n")).toMatch(/4 other CloudTrail trail/);
    const fits = await runPreflight(
      account({ trails: ["a", "b", elsewhere("west-only", false)] }).clients,
      { env: "dev", region: "us-east-1" },
    );
    expect(fits.failures).toEqual([]);
  });

  it("does not count the stack's own trails on a re-run", async () => {
    const { runPreflight } = await load();
    const { failures } = await runPreflight(
      account({
        trails: [
          "org-trail",
          "security",
          "legacy-a",
          "boxalarm-dev-cognito-management-events",
          "boxalarm-dev-alerting-data-events",
        ],
      }).clients,
      { env: "dev", region: "us-east-1" },
    );
    expect(failures).toEqual([]);
  });

  it("fails prod in an account that holds another stack; warns for non-prod neighbours", async () => {
    const { runPreflight } = await load();
    const shared = { trails: ["boxalarm-dev-alerting-data-events"] };
    const prod = await runPreflight(account(shared).clients, { env: "prod", region: "us-east-1" });
    expect(prod.failures.join("\n")).toMatch(/one AWS account per stack, with prod in its own/);
    const qa = await runPreflight(account(shared).clients, { env: "qa", region: "us-east-1" });
    expect(qa.failures).toEqual([]);
    expect(qa.warnings.join("\n")).toContain("dev");
  });

  it("with --first-deploy, fails when the stack's reservations would leave under 100 unreserved", async () => {
    const { runPreflight, STACK_RESERVED_CONCURRENCY } = await load();
    const { failures } = await runPreflight(
      account({ limit: 1000, unreserved: STACK_RESERVED_CONCURRENCY + 50 }).clients,
      { env: "staging", region: "us-east-1", firstDeploy: true },
    );
    expect(failures.join("\n")).toMatch(/must keep 100 free/);
  });
});

describe("preflight's reserved-concurrency figure matches the stack", { timeout: 120_000 }, () => {
  it("equals the sum of reservedConcurrentExecutions across every function", async () => {
    const { STACK_RESERVED_CONCURRENCY } = await load();
    installMocks(STACK_CONFIG);
    await import("../../index");
    await settleStack();
    const total = resourcesOfType("aws:lambda/function:Function").reduce(
      (sum, fn) => sum + (Number(fn.inputs.reservedConcurrentExecutions) || 0),
      0,
    );
    expect(total).toBe(STACK_RESERVED_CONCURRENCY);
  });
});
