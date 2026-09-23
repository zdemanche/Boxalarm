import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

let eventSourceMappingInputs: Record<string, unknown> | undefined;

beforeEach(() => {
  eventSourceMappingInputs = undefined;
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:scheduler/scheduleGroup:ScheduleGroup") {
        state.arn = `arn:aws:scheduler:us-east-1:123456789012:schedule-group/${args.inputs.name}`;
      }
      if (args.type === "aws:lambda/eventSourceMapping:EventSourceMapping") {
        eventSourceMappingInputs = args.inputs;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("FanOut event source mapping", () => {
  it("enables ReportBatchItemFailures and bounded retry so a failed dispatch is never silently dropped", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { Escalation } = await import("../../components/alerting/escalation");
    const { FanOut } = await import("../../components/alerting/fan-out");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const escalation = new Escalation("escalation", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      alertingTableName: "boxalarm-dev-alerting-table",
      logGroup,
    });

    const fanOut = new FanOut("fan-out", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTableName: "boxalarm-dev-alerting-table",
      alertingStreamArn:
        "arn:aws:dynamodb:us-east-1:123456789012:table/alerting/stream/2026-01-01T00:00:00.000",
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      escalation,
      logGroup,
    });

    await resolve(fanOut.eventSourceMapping.functionName);

    expect(eventSourceMappingInputs).toBeDefined();
    expect(eventSourceMappingInputs!.functionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(eventSourceMappingInputs!.bisectBatchOnFunctionError).toBe(true);
    expect(eventSourceMappingInputs!.maximumRetryAttempts).toBe(3);
    expect(eventSourceMappingInputs!.maximumRecordAgeInSeconds).toBe(3600);
  });
});
