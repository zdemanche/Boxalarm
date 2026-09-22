import { describe, expect, it } from "vitest";
import { requireEnv, KNOWN_ENVS } from "../../components/shared/env";

describe("requireEnv (shared)", () => {
  it("accepts every known env without throwing", () => {
    for (const env of KNOWN_ENVS) {
      expect(() => requireEnv("TestComponent", env)).not.toThrow();
    }
  });

  it("throws on an absent or empty env", () => {
    expect(() => requireEnv("TestComponent", "")).toThrow(/env is required/);
    expect(() => requireEnv("TestComponent", undefined as unknown as string)).toThrow(
      /env is required/,
    );
  });

  it("throws on an unknown env, prefixed with the calling component's name", () => {
    expect(() => requireEnv("TestComponent", "production")).toThrow(
      /TestComponent: unknown env "production"/,
    );
  });
});
