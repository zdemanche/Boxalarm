import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resources, installMocks, settleStack, STACK_CONFIG } from "./alerting/mock-harness";

const WEB_ORIGIN = "https://localhost:5173";
const authConfig = (app: "mobile" | "web") =>
  readFileSync(join(__dirname, `../../ui/apps/${app}/src/auth/config.ts`), "utf8");

const clientCallbackUrls = (suffix: "mobile" | "web") =>
  resources.find(
    (r) =>
      r.type === "aws:cognito/userPoolClient:UserPoolClient" &&
      r.inputs.name === `boxalarm-dev-${suffix}`,
  )?.inputs.callbackUrls as string[];

describe("hosted-UI redirect URIs are registered on the matching app client", () => {
  beforeAll(async () => {
    installMocks(STACK_CONFIG);
    await import("../index");
    await settleStack();
  }, 120_000);

  it("mobile: every redirectUrl and redirect_uri in auth/config.ts is a callback URL", () => {
    const uris = [...authConfig("mobile").matchAll(/(?:redirectUrl|redirect_uri): '([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(uris).toContain("boxalarm://sign-in");
    expect(clientCallbackUrls("mobile")).toEqual(expect.arrayContaining(uris));
  });

  it("web: every redirect_uri in auth/config.ts is a callback URL", () => {
    const uris = [
      ...authConfig("web").matchAll(
        /(?:redirect_uri|redirectUri)(?::| =) `\$\{window\.location\.origin\}([^`]*)`/g,
      ),
    ].map((m) => `${WEB_ORIGIN}${m[1]}`);
    expect(uris).toContain(`${WEB_ORIGIN}/login`);
    expect(clientCallbackUrls("web")).toEqual(expect.arrayContaining(uris));
  });
});
