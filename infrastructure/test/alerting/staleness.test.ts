import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { EligibilityStaleness } from "../../components/alerting/staleness";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  installMocks,
  resourcesOfType,
  settle,
} from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

beforeEach(() => {
  installMocks();
});

async function build() {
  const staleness = new EligibilityStaleness("staleness", {
    env: "dev",
    deptId: "nichols-fd",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    pageTopicArn: PAGE_TOPIC_ARN,
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return staleness;
}

describe("EligibilityStaleness", { timeout: 30_000 }, () => {
  it("puts the scheduler role under the alerting-plane permissions boundary", async () => {
    await build();
    const role = resourcesOfType("aws:iam/role:Role").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-staleness-scheduler",
    );
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });
});
