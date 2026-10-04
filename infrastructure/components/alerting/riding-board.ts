import * as pulumi from "@pulumi/pulumi";
import { HttpApi } from "../api/http-api";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { PlatformBus } from "../messaging/platform-bus";
import { QueueConsumer } from "../messaging/queue-consumer";
import { grantAlertingCmk } from "./alerting-cmk";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { AlertingRoute, verifiedPermissionsStatement } from "./route-lambda";

export interface RidingBoardArgs {
  env: string;
  httpApi: HttpApi;
  platformTableArn: pulumi.Input<string>;
  platformTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  policyStoreId: pulumi.Input<string>;
  /** LOB bus: the apparatus.serviceStatus.changed copy is consumed off this, not the alerting plane's own bus. */
  platformBus: PlatformBus;
  alertingTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingLogGroup: ServiceLogGroup;
  alertingPermissionsBoundaryArn?: pulumi.Input<string>;
  /** alerting-page topic: the apparatus-status-changed copy consumer's alarms page. */
  pageTopicArn: pulumi.Input<string>;
}

/**
 * Live riding board (E1-S18-INFRA, partial). The merged backend
 * (src/services/apparatus-service/ridingBoard/handler.ts) reads/writes the
 * platform-service table via apparatus-service's own client, not the alerting table as
 * the ticket's Scope assumed — architecture has no riding-board design yet (ticket's own
 * Current state) and the ticket predates this implementation. Wired here as apparatus
 * routes against the platform table.
 *
 * #235: the two deferred bridges this file's previous revision noted (apparatus-status-
 * changed copy into alerting, and the board-assignment event bridge for incident
 * pre-populate) no longer depend on E4 apparatus infra — apparatus-service's own
 * registry.ts/ridingBoard already emit apparatus.serviceStatus.changed and
 * apparatus.riding_assignment.{assigned,vacated} onto the platform bus via the outbox.
 * The first bridge (alerting-table-only copy) is built here; the second (incident-table-
 * only pre-populate) is built in incident.ts (`ridingAssignmentConsumer`), wiring the
 * already-existing but previously unwired backend handler
 * (incident-service/ridingAssignmentConsumer.ts), since it writes to the incident-service
 * table, not this component's tables.
 */
export class RidingBoard extends pulumi.ComponentResource {
  public readonly getRoute: AlertingRoute;
  public readonly assignRoute: AlertingRoute;
  public readonly apparatusStatusChangedConsumer: ServiceLambda;
  public readonly apparatusStatusChangedQueueConsumer: QueueConsumer;

  constructor(name: string, args: RidingBoardArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RidingBoard", args.env);
    super("boxalarm:alerting:RidingBoard", name, {}, opts);
    const { env } = args;

    const environment = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    // Cast like the table ARN below: ServiceLambda deep-resolves nested Outputs.
    const apparatusIndexArn =
      pulumi.interpolate`${args.platformTableArn}/index/GSI3` as unknown as string;
    const vpStatement = verifiedPermissionsStatement();

    // src/services/apparatus-service/ridingBoard/handler.getRidingBoardHandler
    this.getRoute = new AlertingRoute(
      `${name}-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-riding-board-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("apparatus-service", "riding-board-get"),
        routeKey: "GET /api/v1/apparatus/riding-board/{dispatchId}",
        environment,
        additionalPolicyStatements: [
          {
            Sid: "PlatformTableReadOnly",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.platformTableArn as string,
          },
          {
            // listApparatusForBoard queries IndexName 'GSI3' (ridingBoard/repository.ts);
            // a table-ARN grant does not cover an index.
            Sid: "PlatformTableApparatusIndexQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: apparatusIndexArn,
          },
          vpStatement,
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
        handler: LAMBDA_HANDLER,
        code: lambdaCode("apparatus-service", "riding-board-assign"),
        routeKey: "POST /api/v1/apparatus/riding-board/{dispatchId}/assignments",
        environment,
        additionalPolicyStatements: [
          {
            // assignSeat's single TransactWriteCommand holds a ConditionCheck (apparatus
            // IN_SERVICE), an Update (the seat), and two Puts (history + outbox). DynamoDB
            // authorizes each transaction item as its own action, so all three item
            // actions are required; TransactWriteItems is kept alongside for clarity.
            Sid: "PlatformTableReadWrite",
            Effect: "Allow",
            Action: [
              "dynamodb:GetItem",
              "dynamodb:Query",
              "dynamodb:ConditionCheckItem",
              "dynamodb:UpdateItem",
              "dynamodb:PutItem",
              "dynamodb:TransactWriteItems",
            ],
            Resource: args.platformTableArn as string,
          },
          {
            // findApparatusItem (apparatus-service/repository.ts) queries IndexName 'GSI3'.
            Sid: "PlatformTableApparatusIndexQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: apparatusIndexArn,
          },
          // #257 sweep: the transaction's Update item makes this a mutating role. Inlined
          // (not auditMutationDenyStatement(), which validates its argument eagerly and
          // platformTableArn is an unresolved Output here, like the cast above) but the
          // same shape data/platform-table.ts's auditMutationDenyStatement returns.
          {
            Sid: "DenyAuditMutations",
            Effect: "Deny",
            Action: ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
            Resource: args.platformTableArn as string,
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#AUDIT#*"] },
            },
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    // #235: apparatus.serviceStatus.changed -> alerting-owned copy, alerting-table only
    // (IAM boundary). Reserved concurrency (5) is its own dedicated pool, kept distinct
    // from fan-out.ts's own reservedConcurrentExecutions (10) — a burst of service-status
    // events can never starve tone-out fan-out's capacity, nor the reverse.
    this.apparatusStatusChangedConsumer = new ServiceLambda(
      `${name}-apparatus-status-changed-consumer`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-apparatus-status-changed-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "apparatus-status-changed-consumer"),
        logGroup: args.alertingLogGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        additionalPolicyStatements: pulumi.output(args.alertingTableArn).apply((arn) => [
          {
            Sid: "AlertingApparatusStatusCopyWrite" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: [arn],
          },
        ]),
        permissionsBoundaryArn: args.alertingPermissionsBoundaryArn,
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    this.apparatusStatusChangedQueueConsumer = args.platformBus.addQueueConsumer(
      `${name}-apparatus-status-changed-queue-consumer`,
      {
        env,
        ruleName: `boxalarm-${env}-apparatus-status-changed`,
        // Routing filter, not a trust boundary — see availability.ts's identical note.
        eventPattern: JSON.stringify({
          source: ["apparatus-service"],
          "detail-type": ["apparatus.serviceStatus.changed"],
        }),
        queueName: `boxalarm-${env}-apparatus-status-alerting-copy-queue`,
        lambda: this.apparatusStatusChangedConsumer.function,
        lambdaRole: this.apparatusStatusChangedConsumer.role,
        alarmTopicArn: args.pageTopicArn,
        maxReceiveCount: 5,
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      { apparatusStatusChangedConsumer: this.apparatusStatusChangedConsumer.role },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      getRoute: this.getRoute,
      assignRoute: this.assignRoute,
      apparatusStatusChangedConsumer: this.apparatusStatusChangedConsumer,
    });
  }
}
