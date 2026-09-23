import * as pulumi from "@pulumi/pulumi";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { httpStubCode } from "./stub-code";
import { AlertingRoute } from "./route-lambda";
import { policyStore } from "../authz/policy-store";

export interface RidingBoardArgs {
  env: string;
  httpApi: HttpApi;
  platformTableArn: pulumi.Input<string>;
  platformTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/**
 * Live riding board (E1-S18-INFRA, partial). The merged backend
 * (src/services/apparatus-service/ridingBoard/handler.ts) reads/writes the
 * platform-service table via apparatus-service's own client, not the alerting table as
 * the ticket's Scope assumed — architecture has no riding-board design yet (ticket's own
 * Current state) and the ticket predates this implementation. Wired here as apparatus
 * routes against the platform table; the apparatus-status-changed copy into alerting and
 * the board-assignment bridge event depend on infra from other batches (E4 apparatus
 * infra) not present on this branch, so those two pieces are deferred, not built.
 */
export class RidingBoard extends pulumi.ComponentResource {
  public readonly getRoute: AlertingRoute;
  public readonly assignRoute: AlertingRoute;

  constructor(name: string, args: RidingBoardArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RidingBoard", args.env);
    super("boxalarm:alerting:RidingBoard", name, {}, opts);
    const { env } = args;

    const environment = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
    };
    const verifiedPermissionsStatement = {
      Sid: "VerifiedPermissionsIsAuthorized",
      Effect: "Allow" as const,
      Action: ["verifiedpermissions:IsAuthorizedWithToken"],
      Resource: "*",
    };

    // src/services/apparatus-service/ridingBoard/handler.getRidingBoardHandler
    this.getRoute = new AlertingRoute(
      `${name}-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-riding-board-get`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "GET /api/v1/apparatus/riding-board/{dispatchId}",
        environment,
        additionalPolicyStatements: [
          {
            Sid: "PlatformTableReadOnly",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.platformTableArn as string,
          },
          verifiedPermissionsStatement,
        ],
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    // src/services/apparatus-service/ridingBoard/handler.assignRidingPositionHandler
    this.assignRoute = new AlertingRoute(
      `${name}-assign`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-riding-board-assign`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "POST /api/v1/apparatus/riding-board/{dispatchId}/assignments",
        environment,
        additionalPolicyStatements: [
          {
            Sid: "PlatformTableReadWrite",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
            Resource: args.platformTableArn as string,
          },
          verifiedPermissionsStatement,
        ],
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    this.registerOutputs({ getRoute: this.getRoute, assignRoute: this.assignRoute });
  }
}
