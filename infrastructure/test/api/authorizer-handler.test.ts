import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(__filename);
const { handler } = require(join(__dirname, "../../components/api/authorizer-handler.js")) as {
  handler: (event: { headers?: Record<string, string> }) => Promise<{ isAuthorized: boolean }>;
};

describe("authorizer-handler stub", () => {
  it("always denies (fail-closed), regardless of Authorization header", async () => {
    await expect(handler({ headers: { Authorization: "Bearer token" } })).resolves.toEqual({
      isAuthorized: false,
    });
    await expect(handler({})).resolves.toEqual({ isAuthorized: false });
  });
});
