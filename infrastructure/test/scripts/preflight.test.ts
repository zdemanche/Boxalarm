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
    clients: { lambda: { send: Send }; cloudtrail: { send: Send } },
    options: { env: string; firstDeploy?: boolean },
  ): Promise<PreflightResult>;
  STACK_RESERVED_CONCURRENCY: number;
}
type Send = (command: { constructor: { name: string } }) => Promise<unknown>;

const SCRIPT = path.resolve(__dirname, "../../scripts/preflight.mjs");
const load = async () => (await import(SCRIPT)) as PreflightModule;

function account({
  limit = 1000,
  unreserved = 1000,
  trails = [] as string[],
}: { limit?: number; unreserved?: number; trails?: string[] } = {}) {
  const calls: string[] = [];
  const send: Send = async (command) => {
    calls.push(command.constructor.name);
    switch (command.constructor.name) {
      case "GetAccountSettingsCommand":
        return {
          AccountLimit: { ConcurrentExecutions: limit, UnreservedConcurrentExecutions: unreserved },
        };
      case "DescribeTrailsCommand":
        return { trailList: trails.map((Name) => ({ Name })) };
      default:
        throw new Error(`unexpected call ${command.constructor.name}`);
    }
  };
  return { clients: { lambda: { send }, cloudtrail: { send } }, calls };
}

describe("preflight.mjs", () => {
  it("fails a fresh account (Lambda concurrency quota 10) with the quota to request", async () => {
    const { runPreflight } = await load();
    const { failures } = await runPreflight(account({ limit: 10, unreserved: 10 }).clients, {
      env: "dev",
    });
    expect(failures.join("\n")).toMatch(/quota is 10; Boxalarm needs at least 1000/);
    expect(failures.join("\n")).toContain("L-B99A9384");
  });

  it("passes an account with a 1,000 quota and no other trails, reading only", async () => {
    const { runPreflight } = await load();
    const { clients, calls } = account();
    const result = await runPreflight(clients, { env: "dev", firstDeploy: true });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(calls.sort()).toEqual(["DescribeTrailsCommand", "GetAccountSettingsCommand"]);
  });

  it("fails when the stack's 2 trails would exceed the 5-per-region limit", async () => {
    const { runPreflight } = await load();
    const { failures } = await runPreflight(
      account({ trails: ["org-trail", "security", "legacy-a", "legacy-b"] }).clients,
      { env: "dev" },
    );
    expect(failures.join("\n")).toMatch(/4 other CloudTrail trail\(s\).*limit is 5/);
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
      { env: "dev" },
    );
    expect(failures).toEqual([]);
  });

  it("fails prod in an account that holds another stack; warns for non-prod neighbours", async () => {
    const { runPreflight } = await load();
    const shared = { trails: ["boxalarm-dev-alerting-data-events"] };
    const prod = await runPreflight(account(shared).clients, { env: "prod" });
    expect(prod.failures.join("\n")).toMatch(/one AWS account per stack, with prod in its own/);
    const qa = await runPreflight(account(shared).clients, { env: "qa" });
    expect(qa.failures).toEqual([]);
    expect(qa.warnings.join("\n")).toContain("dev");
  });

  it("with --first-deploy, fails when the stack's reservations would leave under 100 unreserved", async () => {
    const { runPreflight, STACK_RESERVED_CONCURRENCY } = await load();
    const { failures } = await runPreflight(
      account({ limit: 1000, unreserved: STACK_RESERVED_CONCURRENCY + 50 }).clients,
      { env: "staging", firstDeploy: true },
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
