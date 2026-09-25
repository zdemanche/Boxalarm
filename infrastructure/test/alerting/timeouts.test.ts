import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  DEFAULT_WORKER_TIMEOUT_SECONDS,
  MessagingAlerting,
} from "../../components/alerting/messaging-alerting";
import { ChannelWorkers } from "../../components/alerting/channel-workers";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  buildSchedulingChain,
  installMocks,
  lambdaByName,
  resourcesOfType,
  settle,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

describe(
  "alerting-chain Lambdas set explicit timeouts (not the AWS 3s default)",
  { timeout: 30_000 },
  () => {
    it.each([
      ["boxalarm-dev-alerting-fan-out", 30],
      ["boxalarm-dev-alerting-dispatches-create", 29],
      ["boxalarm-dev-alerting-escalation", 15],
      ["boxalarm-dev-alerting-tone-evaluator", 30],
    ])("%s → %ss", async (functionName, seconds) => {
      await buildSchedulingChain();
      expect(lambdaByName(functionName).inputs.timeout).toBe(seconds);
    });

    it("keeps dispatch-ingress under the HTTP API 30s integration ceiling", async () => {
      await buildSchedulingChain();
      expect(lambdaByName("boxalarm-dev-alerting-dispatches-create").inputs.timeout).toBeLessThan(
        30,
      );
    });

    it("sizes each channel queue's visibility to 2x its worker's timeout", async () => {
      const logGroup = new ServiceLogGroup("alerting-lg", {
        env: "dev",
        serviceName: "alerting-service",
      });
      const messaging = new MessagingAlerting("messaging-alerting", { env: "dev" });
      new ChannelWorkers("channel-workers", {
        env: "dev",
        alertingTableArn: TABLE_ARN,
        alertingCmkArn: CMK_ARN,
        alertingTableName: "boxalarm-dev-alerting-table",
        channelQueues: messaging.channelQueues,
        logGroup,
        permissionsBoundaryArn: BOUNDARY_ARN,
      });
      await settle();
      for (const channel of ["push", "sms", "voice"]) {
        const worker = lambdaByName(`boxalarm-dev-alerting-${channel}-worker`);
        expect(worker.inputs.timeout).toBe(DEFAULT_WORKER_TIMEOUT_SECONDS);
        const queue = resourcesOfType("aws:sqs/queue:Queue").find(
          (q) => q.inputs.name === `boxalarm-dev-alerting-${channel}-queue.fifo`,
        );
        expect(queue!.inputs.visibilityTimeoutSeconds).toBe(2 * (worker.inputs.timeout as number));
      }
    });
  },
);
