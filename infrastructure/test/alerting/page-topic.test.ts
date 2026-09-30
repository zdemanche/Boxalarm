import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockMonitor } from "@pulumi/pulumi/runtime/mocks";
import { AlertingPageTopic } from "../../components/alerting/page-topic";
import { installMocks, settle } from "./mock-harness";

/**
 * Post-merge infra review F1: the alerting-page topic moved from AlertingAlarms into its own
 * component. Without aliases an existing stack would create the "new" topic (same name, so
 * the same live ARN) and then delete the old URN - DeleteTopic on the live topic. The mock
 * monitor does not hand aliases to newResource, so this records them at registration.
 */
interface AliasSpec {
  spec?: { name: string; parenturn: string };
}
type RegisterRequest = {
  getName(): string;
  getAliasesList(): { toObject(): AliasSpec }[];
};

const LEGACY_PARENT =
  "urn:pulumi:dev::boxalarm-infra::boxalarm:alerting:AlertingAlarms::alerting-alarms";
const original = MockMonitor.prototype.registerResource;
let aliasesByName: Record<string, AliasSpec[]>;

beforeEach(() => {
  aliasesByName = {};
  MockMonitor.prototype.registerResource = function (
    this: MockMonitor,
    req: RegisterRequest,
    callback: unknown,
  ) {
    aliasesByName[req.getName()] = req.getAliasesList().map((a) => a.toObject());
    return (original as (r: unknown, c: unknown) => Promise<void>).call(this, req, callback);
  } as typeof original;
});

afterEach(() => {
  MockMonitor.prototype.registerResource = original;
});

describe("AlertingPageTopic keeps the pre-move URNs (F1)", { timeout: 30_000 }, () => {
  it("aliases the topic and its subscription to their old AlertingAlarms children", async () => {
    installMocks({ "boxalarm-infra:alertingPageEmail": "oncall@example.test" });
    new AlertingPageTopic("alerting-page", {
      env: "dev",
      legacyAlarmsComponentName: "alerting-alarms",
    });
    await settle();

    expect(aliasesByName["alerting-page-topic"]).toEqual([
      {
        spec: expect.objectContaining({
          name: "alerting-alarms-page-topic",
          parenturn: LEGACY_PARENT,
        }),
      },
    ]);
    expect(aliasesByName["alerting-page-email-subscription"]).toEqual([
      {
        spec: expect.objectContaining({
          name: "alerting-alarms-page-email-subscription",
          parenturn: LEGACY_PARENT,
        }),
      },
    ]);
  });

  it("index.ts names the same component AlertingAlarms is still created as", () => {
    const index = fs.readFileSync(path.join(__dirname, "../../index.ts"), "utf8");
    expect(index).toContain('legacyAlarmsComponentName: "alerting-alarms"');
    expect(index).toContain('new AlertingAlarms("alerting-alarms"');
  });
});
