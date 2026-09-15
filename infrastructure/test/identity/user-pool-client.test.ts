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
        }),
    ).toThrow(/custom:deptId/);
  });
});
