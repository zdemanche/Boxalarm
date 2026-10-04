import { describe, expect, it, vi } from "vitest";
import { createHandler, handler } from "../../components/identity/pre-token-generation-handler.js";

function eventWith(userAttributes: Record<string, string>) {
  return {
    request: { userAttributes },
    response: {},
  };
}

describe("pre-token-generation handler (V2)", () => {
  it("copies custom:deptId from the user's attributes onto the access token", async () => {
    const result = await handler(eventWith({ sub: "abc", "custom:deptId": "nichols-fd" }));

    expect(
      result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride,
    ).toEqual({ "custom:deptId": "nichols-fd" });
  });

  it("leaves the access token untouched when custom:deptId is absent, so the authorizer's fail-closed check is what denies the request", async () => {
    const result = await handler(eventWith({ sub: "abc" }));

    expect(result.response.claimsAndScopeOverrideDetails).toBeUndefined();
  });

  it("leaves the access token untouched when custom:deptId is present but whitespace-only", async () => {
    const result = await handler(eventWith({ sub: "abc", "custom:deptId": "   " }));

    expect(result.response.claimsAndScopeOverrideDetails).toBeUndefined();
  });

  it("returns the event itself, since Cognito requires the trigger to return its input", async () => {
    const event = eventWith({ "custom:deptId": "nichols-fd" });

    expect(await handler(event)).toBe(event);
  });
});

// Review C1: a revoked (LOA/RETIRED) member signed straight back in with the same password.
// This trigger runs on sign-in and on every refresh-token redemption, so refusing here means
// no new token of any kind is minted for an inactive member.
describe("pre-token-generation handler: inactive members get no token (C1)", () => {
  const MEMBER = { sub: "sub-1", "custom:deptId": "nichols-fd" };

  function withStatus(result: Promise<string | undefined>) {
    const readMemberStatus = vi.fn(() => result);
    return { readMemberStatus, run: createHandler({ tableName: "platform", readMemberStatus }) };
  }

  it.each(["LOA", "RETIRED"])(
    "throws (Cognito refuses the token) for a %s member",
    async (status) => {
      const { run, readMemberStatus } = withStatus(Promise.resolve(status));

      await expect(
        run({ triggerSource: "TokenGeneration_RefreshTokens", ...eventWith(MEMBER) }),
      ).rejects.toThrow("Member is not active");
      expect(readMemberStatus).toHaveBeenCalledWith("platform", "nichols-fd", "sub-1");
    },
  );

  it.each(["ACTIVE", "PROBATIONARY"])("issues the token for a %s member", async (status) => {
    const { run } = withStatus(Promise.resolve(status));

    const result = await run(eventWith(MEMBER));

    expect(
      result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride,
    ).toEqual({ "custom:deptId": "nichols-fd" });
  });

  it("issues the token when the member has no row yet (first admin bootstrap)", async () => {
    const { run } = withStatus(Promise.resolve(undefined));

    await expect(run(eventWith(MEMBER))).resolves.toBeDefined();
  });

  it("fails OPEN when the status lookup errors, so a table outage never signs responders out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run } = withStatus(Promise.reject(new Error("timeout")));

    const result = await run(eventWith(MEMBER));

    expect(result.response.claimsAndScopeOverrideDetails).toBeDefined();
    vi.restoreAllMocks();
  });

  it("does not look a member up without a department (nothing to key the row on)", async () => {
    const { run, readMemberStatus } = withStatus(Promise.resolve("LOA"));

    await run(eventWith({ sub: "sub-1" }));

    expect(readMemberStatus).not.toHaveBeenCalled();
  });

  it("does not look up a deptId carrying the pk delimiter", async () => {
    const { run, readMemberStatus } = withStatus(Promise.resolve("LOA"));

    await run(eventWith({ sub: "sub-1", "custom:deptId": "a#MEMBER#x" }));

    expect(readMemberStatus).not.toHaveBeenCalled();
  });
});
