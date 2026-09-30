import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resourcesOfType, settleStack } from "../alerting/mock-harness";

describe(
  "full stack: every Lambda labels its logs with the stack env (m6)",
  { timeout: 120_000 },
  () => {
    it("sets BOXALARM_ENV to the stack env on every function", async () => {
      installMocks(STACK_CONFIG);
      await import("../../index");
      await settleStack();

      const functions = resourcesOfType("aws:lambda/function:Function");
      expect(functions.length).toBeGreaterThan(150);
      const wrong = functions
        .filter((fn) => {
          // A function whose env holds a secret is wrapped by the mock as { value: ... }.
          const environment = fn.inputs.environment as
            | { variables?: Record<string, string>; value?: { variables?: Record<string, string> } }
            | undefined;
          const variables = environment?.variables ?? environment?.value?.variables;
          return variables?.BOXALARM_ENV !== "dev";
        })
        .map((fn) => fn.inputs.name);
      expect(wrong).toEqual([]);
    });
  },
);
