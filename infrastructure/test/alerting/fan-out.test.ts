import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { Escalation } from "../../components/alerting/escalation";
import { FanOut } from "../../components/alerting/fan-out";
import {
  BOUNDARY_ARN,
  STREAM_ARN,
  TABLE_ARN,
  TOPIC_ARN,
  installMocks,
  lambdaEnv,
  settle,
} from "./mock-harness";

const FAN_OUT = "boxalarm-dev-alerting-fan-out";

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const escalation = new Escalation("escalation", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingTopicArn: TOPIC_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  const fanOut = new FanOut("fan-out", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingStreamArn: STREAM_ARN,
    alertingTopicArn: TOPIC_ARN,
    escalation,
    logGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return { escalation, fanOut };
}

describe("FanOut — escalation scheduling wiring", { timeout: 30_000 }, () => {
  it("sets every env var the stream path's escalation + tone-ladder scheduling requires", async () => {
    await build();
    const env = lambdaEnv(FAN_OUT);
    expect(env.ESCALATION_HANDLER_ARN).toBe(
      "arn:aws:lambda:us-east-1:123456789012:function:boxalarm-dev-alerting-escalation",
    );
    expect(env.ESCALATION_SCHEDULER_ROLE_ARN).toBe(
      "arn:aws:iam::123456789012:role/boxalarm-dev-alerting-escalation-scheduler",
    );
    expect(env.TONE_EVALUATOR_HANDLER_ARN).toBe(
      "arn:aws:lambda:us-east-1:123456789012:function:boxalarm-dev-alerting-tone-evaluator",
    );
  });
});
