import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";
import { PlatformBus } from "../messaging/platform-bus";
import { QueueConsumer } from "../messaging/queue-consumer";

export interface LosapArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
  platformBus: PlatformBus;
  /** chief-notifications: the accrual queue's DLQ-depth alarm is LOB, not alerting-page. */
  opsAlarmTopicArn: pulumi.Input<string>;
}

/**
 * E2-S4-INFRA #206: configurable LOSAP point rules and running totals.
 * getMemberLosap/yearEndReport are read-only; updateRules and yearEndReport gate on
 * requireAdminRole in-handler (not Cedar) so neither needs the policy store env var.
 */
export class Losap extends pulumi.ComponentResource {
  public readonly getMemberTotalLambda: ServiceLambda;
  public readonly updateRulesLambda: ServiceLambda;
  public readonly yearEndReportLambda: ServiceLambda;
  public readonly accrualConsumer: ServiceLambda;
  public readonly accrualQueueConsumer: QueueConsumer;

  constructor(name: string, args: LosapArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Losap", args.env);
    super("boxalarm:personnel:Losap", name, {}, opts);
    const { env } = args;

    // getMemberLosap.ts: getMemberLosapTotal is a base-table Query only.
    const memberTotalStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "LosapMemberTotalAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:Query"],
        Resource: [arn],
      },
    ]);
    // yearEndReport.ts: listMembers (GSI3) + getYearEndReport (base-table Query).
    const yearEndStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "LosapYearEndAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:Query"],
        Resource: [arn, `${arn}/index/GSI3`],
      },
    ]);
    const writeStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "LosapRulesWriteAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
        Resource: [arn],
      },
      // #257 sweep: every platform-table-writing role carries the audit-row deny.
      auditMutationDenyStatement(arn),
    ]);

    this.getMemberTotalLambda = new ServiceLambda(
      `${name}-get-member-total`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-losap-member-total`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "losap-get-member-total"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([memberTotalStatement, pulumi.output(args.policyStoreArn)])
          .apply(([table, policyStoreArn]) => [
            ...table,
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-member-total-route`,
      {
        routeKey: "GET /api/v1/personnel/members/{memberId}/losap",
        lambda: this.getMemberTotalLambda,
      },
      { parent: this },
    );

    this.updateRulesLambda = new ServiceLambda(
      `${name}-update-rules`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-losap-update-rules`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "losap-update-rules"),
        logGroup: args.logGroup,
        environment: { PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: writeStatement,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-rules-route`,
      { routeKey: "PUT /api/v1/personnel/losap/rules", lambda: this.updateRulesLambda },
      { parent: this },
    );

    this.yearEndReportLambda = new ServiceLambda(
      `${name}-year-end-report`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-losap-year-end-report`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "losap-year-end-report"),
        logGroup: args.logGroup,
        environment: {
          PERSONNEL_TABLE_NAME: args.platformTableName,
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: yearEndStatement,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-year-end-report-route`,
      { routeKey: "GET /api/v1/personnel/losap/year-end", lambda: this.yearEndReportLambda },
      { parent: this },
    );

    // #206: personnel.attendance.recorded -> boxalarm-{env}-losap-accrual-queue (+DLQ,
    // depth alarm) -> an idempotent EVENT_DEDUP record. The points award itself stays
    // inline on the attendance write path (attendance/handler.ts,
    // shifts/completeShiftAttendance.ts); re-awarding here would double-count a member's
    // points, so this consumer only establishes the event-driven path's own dedup ledger
    // ahead of a later change that moves the award off the write path.
    this.accrualConsumer = new ServiceLambda(
      `${name}-accrual-consumer`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-losap-accrual-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "losap-accrual-consumer"),
        logGroup: args.logGroup,
        environment: { PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((arn) => [
          {
            Sid: "LosapAccrualDedupWrite" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:PutItem"],
            Resource: [arn],
          },
          // #257 sweep: every platform-table-writing role carries the audit-row deny.
          auditMutationDenyStatement(arn),
        ]),
      },
      { parent: this },
    );

    this.accrualQueueConsumer = args.platformBus.addQueueConsumer(
      `${name}-accrual-queue-consumer`,
      {
        env,
        ruleName: `boxalarm-${env}-losap-accrual`,
        // Routing filter, not a trust boundary — see availability.ts's identical note.
        eventPattern: JSON.stringify({
          source: ["personnel-service"],
          "detail-type": ["personnel.attendance.recorded"],
        }),
        queueName: `boxalarm-${env}-losap-accrual-queue`,
        lambda: this.accrualConsumer.function,
        lambdaRole: this.accrualConsumer.role,
        alarmTopicArn: args.opsAlarmTopicArn,
        maxReceiveCount: 5,
      },
      { parent: this },
    );

    this.registerOutputs({
      getMemberTotalLambda: this.getMemberTotalLambda,
      updateRulesLambda: this.updateRulesLambda,
      yearEndReportLambda: this.yearEndReportLambda,
      accrualConsumer: this.accrualConsumer,
    });
  }
}
