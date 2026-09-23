import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

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
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:scheduler/scheduleGroup:ScheduleGroup") {
        state.arn = `arn:aws:scheduler:us-east-1:123456789012:schedule-group/${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("Escalation IAM boundary", () => {
  it("attaches the alerting-plane permissions boundary to the escalation Lambda's own role, not only the scheduler role", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { Escalation } = await import("../../components/alerting/escalation");

    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const boundaryArn = "arn:aws:iam::123456789012:policy/boxalarm-dev-alerting-plane-boundary";

    const escalation = new Escalation("escalation", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingTopicArn: "arn:aws:sns:us-east-1:123456789012:alerting-topic.fifo",
      alertingTableName: "boxalarm-dev-alerting-table",
      logGroup,
      permissionsBoundaryArn: boundaryArn,
    });

    const [lambdaRoleBoundary, schedulerRoleBoundary] = await Promise.all([
      resolve(escalation.lambda.role.permissionsBoundary),
      resolve(escalation.schedulerRole.permissionsBoundary),
    ]);

    expect(lambdaRoleBoundary).toBe(boundaryArn);
    expect(schedulerRoleBoundary).toBe(boundaryArn);
  });
});
