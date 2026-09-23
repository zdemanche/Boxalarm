import { describe, expect, it, vi } from "vitest";
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

  it("recognizes the lowercase 'authorization' header — the shape API Gateway HTTP API v2 actually sends", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        handler({ headers: { authorization: "Bearer some-token-value" } }),
      ).resolves.toEqual({ isAuthorized: false });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string) as { hasAuth: boolean };
      // Proves the lowercase branch, not just the capitalized one, actually matched.
      expect(logged.hasAuth).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never logs the raw Authorization header value or any token material", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handler({ headers: { authorization: "Bearer super-secret-token-value" } });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const loggedPayload = logSpy.mock.calls[0][0] as string;
      expect(loggedPayload).not.toContain("super-secret-token-value");
      expect(loggedPayload).not.toContain("Bearer");
      const logged = JSON.parse(loggedPayload) as Record<string, unknown>;
      // Pins the shape to a boolean signal only — a future edit that starts logging
      // the token itself must fail this assertion.
      expect(typeof logged.hasAuth).toBe("boolean");
    } finally {
      logSpy.mockRestore();
    }
  });
});
