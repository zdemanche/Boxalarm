import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { BoxalarmUserPoolClient } from "../../components/identity/user-pool-client";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: args.inputs,
    }),
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("BoxalarmUserPoolClient", () => {
  it("writeAttributes never includes custom:deptId, even when the caller tries to add it", async () => {
    const client = new BoxalarmUserPoolClient("test-client-mobile", {
      userPoolId: pulumi.output("pool-id"),
      clientName: "mobile",
      standardWriteAttributes: ["email", "name", "phone_number"],
      callbackUrls: ["boxalarm://auth"],
      logoutUrls: ["boxalarm://auth"],
    });

    const writeAttributes = await resolve(client.userPoolClient.writeAttributes);
    expect(writeAttributes).toEqual(["email", "name", "phone_number"]);
    expect(writeAttributes).not.toContain("custom:deptId");
  });

  it("throws at construction, not deploy time, if a caller passes a custom attribute through standardWriteAttributes", () => {
    expect(
      () =>
        new BoxalarmUserPoolClient("test-client-bad", {
          userPoolId: pulumi.output("pool-id"),
          clientName: "mobile",
          standardWriteAttributes: ["email", "custom:deptId"],
          callbackUrls: ["boxalarm://auth"],
          logoutUrls: ["boxalarm://auth"],
        }),
    ).toThrow(/custom:deptId/);
  });

  it("configures authorization-code OAuth without a client secret", async () => {
    const client = new BoxalarmUserPoolClient("test-client-oauth", {
      userPoolId: pulumi.output("pool-id"),
      clientName: "web",
      standardWriteAttributes: ["email", "name"],
      callbackUrls: ["https://localhost:5173/auth/callback"],
      logoutUrls: ["https://localhost:5173/"],
      explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    });

    const [
      generateSecret,
      allowedOauthFlows,
      allowedOauthFlowsUserPoolClient,
      allowedOauthScopes,
      callbackUrls,
      logoutUrls,
      preventUserExistenceErrors,
      explicitAuthFlows,
      supportedIdentityProviders,
    ] = await Promise.all([
      resolve(client.userPoolClient.generateSecret),
      resolve(client.userPoolClient.allowedOauthFlows),
      resolve(client.userPoolClient.allowedOauthFlowsUserPoolClient),
      resolve(client.userPoolClient.allowedOauthScopes),
      resolve(client.userPoolClient.callbackUrls),
      resolve(client.userPoolClient.logoutUrls),
      resolve(client.userPoolClient.preventUserExistenceErrors),
      resolve(client.userPoolClient.explicitAuthFlows),
      resolve(client.userPoolClient.supportedIdentityProviders),
    ]);

    expect(generateSecret).toBe(false);
    expect(allowedOauthFlows).toEqual(["code"]);
    expect(allowedOauthFlowsUserPoolClient).toBe(true);
    expect(allowedOauthScopes).toEqual(["openid", "profile", "email"]);
    expect(callbackUrls).toEqual(["https://localhost:5173/auth/callback"]);
    expect(logoutUrls).toEqual(["https://localhost:5173/"]);
    expect(preventUserExistenceErrors).toBe("ENABLED");
    expect(explicitAuthFlows).toEqual(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(supportedIdentityProviders).toEqual(["COGNITO"]);
  });
});
