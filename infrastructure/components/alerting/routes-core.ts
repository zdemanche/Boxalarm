import * as pulumi from "@pulumi/pulumi";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { httpStubCode } from "./stub-code";
import { AlertingRoute } from "./route-lambda";
import { policyStore } from "../authz/policy-store";
import { Escalation } from "./escalation";

export interface RoutesCoreArgs {
  env: string;
  httpApi: HttpApi;
  alertingTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  /**
   * Manual dispatch ingress (dispatches/handler.ts -> fanOut.ts) is the Lambda that
   * actually calls createEscalationSchedule — the scheduler-create/PassRole grant and
   * the ESCALATION_HANDLER_ARN/ESCALATION_SCHEDULER_ROLE_ARN env vars belong here, not
   * on the stream fan-out Lambda (fan-out.ts no longer carries them).
   */
  escalation: Escalation;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

function verifiedPermissionsStatement(): IamPolicyStatement {
  return {
    Sid: "VerifiedPermissionsIsAuthorized",
    Effect: "Allow",
    Action: ["verifiedpermissions:IsAuthorizedWithToken"],
    Resource: "*",
  };
}

/**
 * Core alerting-service routes, each with its own reserved concurrency separate from
 * fan-out and the channel workers (E1-S1/S5/S6-INFRA): manual dispatch ingress
 * (degraded-mode fallback), response confirmation, live roster, and dispatch detail.
 */
export class RoutesCore extends pulumi.ComponentResource {
  public readonly dispatchIngress: AlertingRoute;
  public readonly responses: AlertingRoute;
  public readonly roster: AlertingRoute;
  public readonly detail: AlertingRoute;

  constructor(name: string, args: RoutesCoreArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RoutesCore", args.env);
    super("boxalarm:alerting:RoutesCore", name, {}, opts);
    const { env } = args;

    // src/services/alerting-service/dispatches/handler.handler -> fanOut.ts -> runFanOut:
    // queryEligibleMembers is a Query, readEscalationThresholdSeconds is a GetItem, and
    // createEscalationSchedule needs scheduler:CreateSchedule + iam:PassRole on the
    // escalation scheduler role. Without these, queryEligibleMembers throws, the error is
    // swallowed (dispatches/handler.ts catches and still returns 201), and no roster
    // entries or escalation schedules are ever written.
    const dispatchIngressPolicyStatements: pulumi.Input<IamPolicyStatement[]> = pulumi
      .all([args.escalation.scheduleResourcePattern, args.escalation.schedulerRole.arn])
      .apply(([schedulePatterns, schedulerRoleArn]) => [
        {
          Sid: "AlertingTableConditionalWrite",
          Effect: "Allow" as const,
          Action: [
            "dynamodb:PutItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:TransactWriteItems",
            "dynamodb:Query",
            "dynamodb:GetItem",
          ],
          Resource: args.alertingTableArn as string,
        },
        verifiedPermissionsStatement(),
        {
          Sid: "CreateEscalationSchedulesOnly",
          Effect: "Allow" as const,
          Action: ["scheduler:CreateSchedule"],
          Resource: schedulePatterns,
        },
        {
          Sid: "PassSchedulerRoleOnly",
          Effect: "Allow" as const,
          Action: ["iam:PassRole"],
          Resource: schedulerRoleArn,
          Condition: { StringEquals: { "iam:PassedToService": ["scheduler.amazonaws.com"] } },
        },
      ]);

    // src/services/alerting-service/dispatches/handler.handler
    this.dispatchIngress = new AlertingRoute(
      `${name}-dispatch-ingress`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-dispatches-create`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "POST /api/v1/alerting/dispatches",
        environment: {
          ALERTING_DISPATCHES_TABLE_NAME: args.alertingTableName,
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
          ESCALATION_HANDLER_ARN: args.escalation.lambda.function.arn,
          ESCALATION_SCHEDULER_ROLE_ARN: args.escalation.schedulerRole.arn,
        },
        additionalPolicyStatements: dispatchIngressPolicyStatements,
        reservedConcurrentExecutions: 5,
        // runFanOut loops serially per member (TransactWrite, then GetItem, then
        // CreateSchedule) — the AWS default 3s is exceeded mid-roster well before 30-40
        // members. 29s is the API Gateway HTTP API integration's own hard ceiling, so a
        // larger Lambda timeout here would just be dead time.
        timeout: 29,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/responses/handler.handler
    this.responses = new AlertingRoute(
      `${name}-responses`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-responses`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/responses",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableReadWrite",
            Effect: "Allow",
            Action: [
              "dynamodb:TransactWriteItems",
              "dynamodb:UpdateItem",
              "dynamodb:PutItem",
              "dynamodb:GetItem",
            ],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement(),
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/roster/handler.handler
    this.roster = new AlertingRoute(
      `${name}-roster`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-roster`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/roster",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement(),
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/dispatches/detail/handler.handler
    this.detail = new AlertingRoute(
      `${name}-detail`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-dispatch-detail`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableReadOnly",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement(),
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    this.registerOutputs({
      dispatchIngress: this.dispatchIngress,
      responses: this.responses,
      roster: this.roster,
      detail: this.detail,
    });
  }
}
