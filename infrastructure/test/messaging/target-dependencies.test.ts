import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockMonitor } from "@pulumi/pulumi/runtime/mocks";
import {
  STACK_CONFIG,
  installMocks,
  resourcesOfType,
  settleStack,
  type PolicyStatement,
} from "../alerting/mock-harness";

/**
 * Review F7: an EventBridge target registered before its queue's policy exists has its
 * first deliveries denied. The mock monitor does not pass dependsOn to newResource, so the
 * registration requests are recorded here.
 */
type RegisterRequest = {
  getType(): string;
  getName(): string;
  getDependenciesList(): string[];
};
const original = MockMonitor.prototype.registerResource;
const dependencies = new Map<string, string[]>();

describe(
  "full stack: every rule target waits for its queue policy (F7)",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      MockMonitor.prototype.registerResource = function (
        this: MockMonitor,
        req: RegisterRequest,
        callback: unknown,
      ) {
        if (req.getType() === "aws:cloudwatch/eventTarget:EventTarget") {
          dependencies.set(req.getName(), req.getDependenciesList());
        }
        return (original as (r: unknown, c: unknown) => Promise<void>).call(this, req, callback);
      } as typeof original;
      installMocks(STACK_CONFIG);
      await import("../../index");
      await settleStack();
    }, 120_000);

    afterAll(() => {
      MockMonitor.prototype.registerResource = original;
    });

    it("depends on the QueuePolicy that grants its rule SendMessage on its queue", () => {
      const policyNameByQueue = new Map<string, string[]>();
      for (const policy of resourcesOfType("aws:sqs/queuePolicy:QueuePolicy")) {
        const statements = (
          JSON.parse(policy.inputs.policy as string) as { Statement: PolicyStatement[] }
        ).Statement;
        for (const s of statements) {
          const queue = s.Resource as string;
          policyNameByQueue.set(queue, [...(policyNameByQueue.get(queue) ?? []), policy.name]);
        }
      }
      const sqsTargets = resourcesOfType("aws:cloudwatch/eventTarget:EventTarget").filter((t) =>
        String(t.inputs.arn).startsWith("arn:aws:sqs:"),
      );
      expect(sqsTargets.length).toBeGreaterThanOrEqual(19);
      const missing = sqsTargets
        .filter((t) => {
          const deps = dependencies.get(t.name) ?? [];
          const policies = policyNameByQueue.get(t.inputs.arn as string) ?? [];
          return !policies.some((p) => deps.some((urn) => urn.endsWith(`::${p}`)));
        })
        .map((t) => t.name);
      expect(missing).toEqual([]);
    });
  },
);
