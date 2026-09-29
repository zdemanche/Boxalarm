import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({ existsSync: vi.fn() }));

import * as fs from "fs";
import { lambdaCode, LAMBDA_HANDLER } from "../../components/shared/lambda-code";
import { PLACEHOLDER_SOURCE } from "../../components/shared/placeholder-code";

const existsSync = vi.mocked(fs.existsSync);

describe("lambdaCode (shared)", () => {
  afterEach(() => {
    existsSync.mockReset();
  });

  it("falls back to the placeholder archive when the bundle doesn't exist", () => {
    existsSync.mockReturnValue(false);

    const code = lambdaCode("platform-service", "does-not-exist");

    expect(code).toBeInstanceOf(pulumi.asset.AssetArchive);
    expect(code).not.toBeInstanceOf(pulumi.asset.FileArchive);
  });

  it("uses the caller's fallback instead of the 501 placeholder when given one (authorizer)", () => {
    existsSync.mockReturnValue(false);
    const warnSpy = vi.spyOn(pulumi.log, "warn").mockResolvedValue();
    const fallback = new pulumi.asset.AssetArchive({});

    const code = lambdaCode("platform-service", "authorizer", () => fallback);

    expect(code).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fail-closed fallback"));
    warnSpy.mockRestore();
  });

  it("ignores the fallback when the bundle exists", () => {
    existsSync.mockReturnValue(true);
    const fallback = vi.fn();

    const code = lambdaCode("platform-service", "authorizer", fallback);

    expect(code).toBeInstanceOf(pulumi.asset.FileArchive);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("logs a Pulumi warning when falling back to the placeholder, so a missing bundle is loud", async () => {
    existsSync.mockReturnValue(false);
    const warnSpy = vi.spyOn(pulumi.log, "warn").mockResolvedValue();

    lambdaCode("platform-service", "does-not-exist");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no bundle found for platform-service/does-not-exist"),
    );
    warnSpy.mockRestore();
  });

  it("does not warn when the bundle exists", () => {
    existsSync.mockReturnValue(true);
    const warnSpy = vi.spyOn(pulumi.log, "warn").mockResolvedValue();

    lambdaCode("platform-service", "audit");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns a FileArchive of backend/dist/<service>/<function> when the bundle exists", async () => {
    existsSync.mockReturnValue(true);

    const code = lambdaCode("platform-service", "audit");

    expect(code).toBeInstanceOf(pulumi.asset.FileArchive);
    const resolvedPath = await (code as pulumi.asset.FileArchive).path;
    expect(resolvedPath.replace(/\\/g, "/")).toMatch(/backend\/dist\/platform-service\/audit$/);
  });

  it("checks for index.mjs at the exact <service>/<function> path", () => {
    existsSync.mockReturnValue(false);

    lambdaCode("personnel-service", "members-create");

    expect(existsSync).toHaveBeenCalledWith(
      path.join(
        path.resolve(__dirname, "../../../backend/dist"),
        "personnel-service",
        "members-create",
        "index.mjs",
      ),
    );
  });

  it("exposes index.handler as the handler string for both placeholder and bundled code", () => {
    expect(LAMBDA_HANDLER).toBe("index.handler");
  });

  // Design review M5: a missing bundle must never quietly replace paging code.
  it("fails a non-dev stack on a missing bundle instead of deploying the placeholder", () => {
    existsSync.mockReturnValue(false);
    const stackSpy = vi.spyOn(pulumi, "getStack").mockReturnValue("prod");
    expect(() => lambdaCode("alerting-service", "fan-out")).toThrow(
      /no bundle found for alerting-service\/fan-out.*stack "prod"/,
    );
    stackSpy.mockReturnValue("staging");
    expect(() => lambdaCode("alerting-service", "push-worker")).toThrow(/stack "staging"/);
    stackSpy.mockRestore();
  });

  it("a non-dev stack with the bundle present deploys it", () => {
    existsSync.mockReturnValue(true);
    const stackSpy = vi.spyOn(pulumi, "getStack").mockReturnValue("prod");
    expect(lambdaCode("alerting-service", "fan-out")).toBeInstanceOf(pulumi.asset.FileArchive);
    stackSpy.mockRestore();
  });
});

describe("placeholder Lambda (dev only)", () => {
  async function invoke(event: unknown): Promise<unknown> {
    const module = { exports: {} as { handler?: (e: unknown) => Promise<unknown> } };
    new Function("exports", "module", PLACEHOLDER_SOURCE)(module.exports, module);
    return module.exports.handler!(event);
  }

  it.each([
    ["a DynamoDB stream batch", { Records: [{ eventSource: "aws:dynamodb" }] }],
    ["an SQS batch", { Records: [{ eventSource: "aws:sqs" }] }],
    ["a Scheduler / async payload", { deptId: "d", dispatchId: "x", toneSequence: 2 }],
    ["an empty event", undefined],
  ])("throws on %s so it retries into its DLQ instead of being acknowledged", async (_l, event) => {
    await expect(invoke(event)).rejects.toThrow(/no backend bundle/);
  });

  it("answers an HTTP API request with a 501 problem", async () => {
    await expect(
      invoke({ routeKey: "GET /x", requestContext: { http: { method: "GET" } } }),
    ).resolves.toMatchObject({ statusCode: 501 });
  });
});
