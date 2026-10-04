import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALERTING_PLANE_ROUTES, OFFICER_ALERTING_READ_ROUTES } from "../../components/api/http-api";

/**
 * Guards the fail-open seam between the authorizer and the API (arch-amendments review M7):
 * the backend's FAIL_OPEN_ROUTE_KEYS (platform-service/authorizer/revocationCheck.ts) must be
 * exactly the routes served by the fail-open alerting authorizer (ALERTING_PLANE_ROUTES), and
 * never an officer read route. A prefix match once forced the deliberately fail-closed read
 * routes open; exact keys pinned on both sides make that drift a test failure instead.
 */
function backendFailOpenKeys(): string[] {
  const source = readFileSync(
    path.resolve(
      __dirname,
      "../../../backend/src/services/platform-service/authorizer/revocationCheck.ts",
    ),
    "utf8",
  );
  const block = /export const FAIL_OPEN_ROUTE_KEYS: readonly string\[\] = \[([\s\S]*?)\];/.exec(
    source,
  );
  if (!block?.[1]) throw new Error("FAIL_OPEN_ROUTE_KEYS not found in revocationCheck.ts");
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe("authorizer fail-open route keys ↔ ALERTING_PLANE_ROUTES", () => {
  it("lists exactly the routes on the fail-open alerting authorizer", () => {
    const backend = backendFailOpenKeys().sort();
    const infra = Object.keys(ALERTING_PLANE_ROUTES).sort();
    expect(backend).toEqual(infra);
  });

  it("never lists an officer read route (those fail closed by design)", () => {
    const backend = new Set(backendFailOpenKeys());
    for (const route of OFFICER_ALERTING_READ_ROUTES) {
      expect(backend.has(route), route).toBe(false);
    }
  });
});
