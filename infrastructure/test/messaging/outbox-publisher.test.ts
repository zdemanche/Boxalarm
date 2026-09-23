import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("OutboxPublisher", () => {
  async function build() {
    const { OutboxPublisher } = await import("../../components/messaging/outbox-publisher");
    const logGroup = new ServiceLogGroup("test-outbox-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    return new OutboxPublisher("test-outbox", {
      env: "dev",
      platformTableName: pulumi.output("boxalarm-dev-platform-service"),
      platformTableStreamArn: pulumi.output(
        "arn:aws:dynamodb:us-east-1:123456789012:table/x/stream/y",
      ),
      busName: pulumi.output("boxalarm-dev-platform-bus"),
      busArn: pulumi.output(
        "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus",
      ),
      logGroup,
    });
  }

  it("filters the DynamoDB stream to entityType = OUTBOX_ENTRY — the single-owner filter the ticket requires", async () => {
    const publisher = await build();
    const filters = await resolve(publisher.eventSourceMapping.filterCriteria);
    const pattern = JSON.parse(filters?.filters?.[0]?.pattern ?? "{}") as {
      dynamodb: { NewImage: { entityType: { S: string[] } } };
    };
    expect(pattern.dynamodb.NewImage.entityType.S).toEqual(["OUTBOX_ENTRY"]);
  });

  it("sets both bus env names backend outbox publishers read (PLATFORM_BUS_NAME, PLATFORM_EVENT_BUS_NAME)", async () => {
    const publisher = await build();
    const env = await resolve(publisher.lambda.function.environment);
    expect(env?.variables?.PLATFORM_BUS_NAME).toBe("boxalarm-dev-platform-bus");
    expect(env?.variables?.PLATFORM_EVENT_BUS_NAME).toBe("boxalarm-dev-platform-bus");
  });

  it("bisects the batch on function error so one bad record doesn't stall the whole stream", async () => {
    const publisher = await build();
    const bisect = await resolve(publisher.eventSourceMapping.bisectBatchOnFunctionError);
    expect(bisect).toBe(true);
  });
});
