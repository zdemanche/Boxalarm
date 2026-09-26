import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PlatformBus } from "../../components/messaging/platform-bus";
import { Quals } from "../../components/personnel/quals";
import {
  ACCOUNT_ID,
  CMK_ARN,
  BOUNDARY_ARN,
  REGION,
  installMocks,
  isGranted,
  lambdaEnv,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * #327 review (MIN-8): each personnel Lambda's env keys and IAM grants, asserted against
 * what its backend handler actually reads and calls (the review traced each one). Mocked
 * backend unit tests cannot see an infra/handler mismatch; these can.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const ALERTING_TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-alerting-table`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("personnel-lg", {
    env: "dev",
    serviceName: "personnel-service",
  });
  const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const platformBus = new PlatformBus("platform-bus", { env: "dev" });
  const common = {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    // An Output, as index.ts passes it — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  };
  const alerting = {
    platformBus,
    alertingTableArn: ALERTING_TABLE,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingLogGroup,
    alertingPermissionsBoundaryArn: BOUNDARY_ARN,
  };
  new Quals("quals", { ...common, ...alerting });
  await settle();
}

describe("personnel Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  describe("quals", () => {
    it("GET can Query the base table (readQuals) and holds no write action", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-quals-get");
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
    });

    it("GET and PUT carry every env key readPersonnelServiceConfig requires", async () => {
      await build();
      for (const fn of ["boxalarm-dev-personnel-quals-get", "boxalarm-dev-personnel-quals-put"]) {
        expect(Object.keys(lambdaEnv(fn))).toEqual(
          expect.arrayContaining([
            "PERSONNEL_TABLE_NAME",
            "PLATFORM_BUS_NAME",
            "VERIFIED_PERMISSIONS_POLICY_STORE_ID",
          ]),
        );
      }
    });

    it("PUT can GetItem (member + cert lookups) and PutItem (qual + outbox transaction)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-quals-put");
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
    });
  });
});
