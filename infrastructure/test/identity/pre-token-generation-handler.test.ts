import { describe, expect, it } from "vitest";
import { handler } from "../../components/identity/pre-token-generation-handler.js";

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
