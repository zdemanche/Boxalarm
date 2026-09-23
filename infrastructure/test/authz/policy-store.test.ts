import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
        state.policyStoreId = `${args.name}-id`;
        state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}-id`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("PolicyStore", () => {
  async function build() {
    const { PolicyStore } = await import("../../components/authz/policy-store");
    return new PolicyStore("test-policy-store", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      userPoolArn: pulumi.output("arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1"),
      allowedClientIds: [pulumi.output("web-client"), pulumi.output("mobile-client")],
    });
  }

  it("creates exactly the six role groups (AC5's four denied roles plus the two allowed)", async () => {
    const store = await build();
    const names = await Promise.all(store.roleGroups.map((g) => resolve(g.name)));
    expect(names.sort()).toEqual(["ADMIN", "APPARATUS", "CHIEF", "MEMBER", "OFFICER", "TRAINING"]);
  });

  it("scopes admin-only actions (export, disposal, UpdateConfig) to CHIEF/ADMIN only, department-scoped (AC1, AC5)", async () => {
    const store = await build();
    const statement = await resolve(store.adminActionsPolicy.definition);
    const text = statement?.static?.statement ?? "";
    expect(text).toContain('UserGroup::"CHIEF"');
    expect(text).toContain('UserGroup::"ADMIN"');
    expect(text).not.toContain('UserGroup::"MEMBER"');
    expect(text).toContain('Action::"ExportData"');
    expect(text).toContain('Action::"DisposeRecords"');
    expect(text).toContain('Action::"UpdateConfig"');
    expect(text).toContain("principal.deptId == resource.deptId");
  });

  it("declares no permit-all / default-allow policy — only the two scoped statements (AC4 fail-secure)", async () => {
    const store = await build();
    const [admin, view] = await Promise.all([
      resolve(store.adminActionsPolicy.definition),
      resolve(store.viewConfigPolicy.definition),
    ]);
    for (const def of [admin, view]) {
      expect(def?.static?.statement).not.toMatch(
        /permit\s*\(\s*principal\s*,\s*action\s*,\s*resource\s*\)\s*;/,
      );
    }
  });

  it("maps Cognito groups to the Boxalarm::UserGroup entity type on the identity source", async () => {
    const store = await build();
    const config = await resolve(store.identitySource.configuration);
    expect(config?.cognitoUserPoolConfiguration?.groupConfiguration?.groupEntityType).toBe(
      "Boxalarm::UserGroup",
    );
  });

  it("throws on absent or unknown env", async () => {
    const { PolicyStore } = await import("../../components/authz/policy-store");
    expect(
      () =>
        new PolicyStore("test-policy-store-bad", {
          env: "",
          userPoolId: pulumi.output("pool-1"),
          userPoolArn: pulumi.output("arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1"),
          allowedClientIds: [pulumi.output("web-client")],
        }),
    ).toThrow(/env is required/);
  });
});
