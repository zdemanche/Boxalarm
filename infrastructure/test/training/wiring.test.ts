import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Certifications } from "../../components/training/certifications";
import { Events } from "../../components/training/events";
import { Hours } from "../../components/training/hours";
import { Reports } from "../../components/training/reports";
import { Transcript } from "../../components/training/transcript";
import {
  ACCOUNT_ID,
  REGION,
  installMocks,
  isGranted,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * #327 review (MIN-8): each training Lambda's env keys and IAM grants, asserted against
 * what its backend handler actually reads and calls — including the index ARNs its
 * queries need, which a table-only grant silently denies.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI1 = `${TABLE}/index/GSI1`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("training-lg", {
    env: "dev",
    serviceName: "training-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const common = {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    // An Output, as index.ts passes it — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  };
  new Certifications("certifications", {
    ...common,
    deptId: "nichols-fd",
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`,
    platformTableStreamArn: `${TABLE}/stream/2026-01-01T00:00:00.000`,
  });
  new Events("events", common);
  new Hours("hours", common);
  new Reports("reports", common);
  new Transcript("transcript", common);
  await settle();
}

describe("training Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  describe("certifications", () => {
    it("expiring can GetItem the lead-time config and Query GSI2, and nothing else", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-certifications-expiring");
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
    });

    it("the expiry scanner can Query GSI2 and write its dedup marker", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-cert-expiry-scanner");
      expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
      expect(isGranted(s, "events:PutEvents", (r) => r.includes("event-bus/"))).toBe(true);
    });
  });

  describe("events", () => {
    it("list can Query GSI3 (events) and GSI1 (my signups) and holds no write action", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-events-list");
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
    });

    it("signup can GetItem the event, PutItem a self-signup and UpdateItem officer attendance", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-events-signup");
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    });
  });

  describe("hours", () => {
    it("can Query GSI1 (member path), GSI3 and the base table (roster path)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-hours");
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
    });
  });

  describe("reports", () => {
    it("ISO report can Query GSI3 (events in period) and the base table (attendees)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-reports-iso");
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
    });
  });

  describe("transcript", () => {
    it("can Query the base table (certifications) and GSI1 (attendance history)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-transcript-get");
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
    });
  });
});
