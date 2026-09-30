import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import {
  REQUIRED_CONFIG,
  stackConfigProblems,
  validateStackConfig,
} from "../../components/shared/stack-config";
import { installMocks } from "../alerting/mock-harness";

const reader =
  (values: Record<string, string>) =>
  (key: string): string | undefined =>
    values[key];

const COMPLETE_DEV: Record<string, string> = {
  env: "dev",
  webOrigin: "https://localhost:5173",
  deptId: "nichols-fd",
  nerisSchemaSourceUrl: "https://schema.example.test/neris",
  notificationSesFromAddress: "notifications@boxalarm.example",
  smsWebhookSecret: "s",
  voiceWebhookSecret: "v",
  pushWebhookSecret: "p",
};

describe("validateStackConfig (deploy-readiness C2)", () => {
  it("reports EVERY missing key in one error, not one per preview", () => {
    let message = "";
    try {
      validateStackConfig(reader({ env: "dev" }), "dev");
    } catch (error) {
      message = (error as Error).message;
    }
    for (const key of [
      "webOrigin",
      "deptId",
      "nerisSchemaSourceUrl",
      "notificationSesFromAddress",
      "smsWebhookSecret",
      "voiceWebhookSecret",
      "pushWebhookSecret",
    ]) {
      expect(message).toContain(`boxalarm-infra:${key}`);
    }
    expect(message).toMatch(/has 7 configuration problem/);
  });

  it("gives the set command for each key, with --secret for secrets only", () => {
    const problems = stackConfigProblems(reader({ env: "dev" }), "dev").join("\n");
    expect(problems).toContain("pulumi config set --secret smsWebhookSecret");
    expect(problems).toContain("pulumi config set deptId nichols-fd --stack dev");
    expect(problems).not.toContain("--secret deptId");
  });

  it("passes a complete dev stack; empty strings count as missing", () => {
    expect(stackConfigProblems(reader(COMPLETE_DEV), "dev")).toEqual([]);
    expect(stackConfigProblems(reader({ ...COMPLETE_DEV, deptId: " " }), "dev")).toHaveLength(1);
  });

  it("requires canaryMemberId only once the canary is enabled (m4)", () => {
    expect(stackConfigProblems(reader(COMPLETE_DEV), "dev")).toEqual([]);
    const enabled = stackConfigProblems(reader({ ...COMPLETE_DEV, canaryEnabled: "true" }), "dev");
    expect(enabled.join("\n")).toContain("--secret canaryMemberId");
  });

  it("requires both notification emails in prod only", () => {
    const prod = stackConfigProblems(reader({ ...COMPLETE_DEV, env: "prod" }), "prod").join("\n");
    expect(prod).toContain("boxalarm-infra:alertingPageEmail");
    expect(prod).toContain("boxalarm-infra:chiefNotificationEmail");
    const staging = stackConfigProblems(reader({ ...COMPLETE_DEV, env: "staging" }), "staging");
    expect(staging.join("\n")).not.toContain("Email");
  });

  it("marks exactly the credential-like keys secret", () => {
    expect(REQUIRED_CONFIG.filter((k) => k.secret).map((k) => k.key)).toEqual([
      "smsWebhookSecret",
      "voiceWebhookSecret",
      "pushWebhookSecret",
      "canaryMemberId",
    ]);
  });
});

describe(
  "index.ts validates the whole config before building anything",
  { timeout: 120_000 },
  () => {
    it("fails with every missing key at once", async () => {
      installMocks();
      pulumi.runtime.setAllConfig({
        "boxalarm-infra:env": "dev",
        "boxalarm-infra:webOrigin": "https://localhost:5173",
      });
      await expect(import("../../index")).rejects.toThrow(
        /deptId[\s\S]*nerisSchemaSourceUrl[\s\S]*notificationSesFromAddress[\s\S]*smsWebhookSecret[\s\S]*voiceWebhookSecret[\s\S]*pushWebhookSecret/,
      );
    });
  },
);
