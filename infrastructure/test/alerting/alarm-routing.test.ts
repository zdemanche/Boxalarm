import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resourcesOfType, settleStack } from "./mock-harness";

// Dashboard-only on purpose until the backend's staleness metric measures propagation
// lag rather than absolute snapshot age (staleness.ts) — it would page permanently.
const DASHBOARD_ONLY = new Set(["boxalarm-dev-alerting-eligibility-snapshot-stale"]);
const PAGE_TOPIC = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";
const OPS_TOPIC = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-chief-notifications";

describe("full stack: no alarm notifies nobody (deploy-readiness M1)", { timeout: 120_000 }, () => {
  it("every alarm in the stack has at least one alarm action", async () => {
    installMocks(STACK_CONFIG);
    await import("../../index");
    await settleStack();

    const alarms = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm");
    expect(alarms.length).toBeGreaterThan(100);
    expect(
      alarms.filter((a) => String(a.inputs.name).includes("-alerting-")).length,
    ).toBeGreaterThan(10);
    const silent = alarms
      .filter((a) => !DASHBOARD_ONLY.has(String(a.inputs.name)))
      .filter((a) => !Array.isArray(a.inputs.alarmActions) || a.inputs.alarmActions.length === 0)
      .map((a) => a.inputs.name);
    expect(silent).toEqual([]);

    const actionsOf = (name: string) =>
      alarms.find((a) => a.inputs.name === name)?.inputs.alarmActions;
    // Alerting-feeding: a failure here leaves the paging snapshot stale or a lost session live.
    for (const name of [
      "boxalarm-dev-outbox-publisher-onfailure-depth",
      "boxalarm-dev-eligibility-changed-snapshot-queue-dlq-depth",
      "boxalarm-dev-eligibility-changed-failed-invocations",
      "boxalarm-dev-availability-snapshot-queue-dlq-depth",
      "boxalarm-dev-availability-changed-failed-invocations",
      "boxalarm-dev-member-status-revocation-queue-dlq-depth",
      "boxalarm-dev-member-status-revocation-failed-invocations",
      "boxalarm-dev-cert-expired-reactor-onfailure-depth",
      "boxalarm-dev-training-eligibility-flip-failed",
      "boxalarm-dev-alerting-bridge-malformed-row",
      "boxalarm-dev-alerting-schedule-dlq-not-empty",
    ]) {
      expect(actionsOf(name), name).toEqual([PAGE_TOPIC]);
    }
    // Everything else notifies the ops topic.
    for (const name of [
      "boxalarm-dev-reporting-projection-queue-dlq-depth",
      "boxalarm-dev-incident-neris-submission-queue-dlq-depth",
      "boxalarm-dev-incident-outbox-drain-onfailure-depth",
      "boxalarm-dev-notification-digest-errors",
      "boxalarm-dev-inventory-ppe-expiry-scanner-dlq-depth",
      "boxalarm-dev-outbox-malformed-row",
    ]) {
      expect(actionsOf(name), name).toEqual([OPS_TOPIC]);
    }
  });
});
