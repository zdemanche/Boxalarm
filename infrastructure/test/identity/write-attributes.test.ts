import { describe, expect, it } from "vitest";
import { clientWriteAttributes } from "../../components/identity/write-attributes";

describe("clientWriteAttributes", () => {
  it("returns the given standard attributes untouched", () => {
    expect(clientWriteAttributes(["email", "name", "phone_number"])).toEqual([
      "email",
      "name",
      "phone_number",
    ]);
  });

  it("throws rather than letting custom:deptId reach an app client's self-service write list", () => {
    // #180 / boxalarm-backend tokenVerifier.ts: Cognito defaults custom
    // attributes to writable, so a member could self-assign a department unless this
    // is excluded. This structurally forbids it rather than relying on remembering to
    // omit it by hand at every call site.
    expect(() => clientWriteAttributes(["email", "custom:deptId"])).toThrow(/custom:deptId/);
  });

  it("throws for any custom: attribute, not just deptId, since none of them are self-service today", () => {
    expect(() => clientWriteAttributes(["custom:foo"])).toThrow(/custom:/);
  });
});
