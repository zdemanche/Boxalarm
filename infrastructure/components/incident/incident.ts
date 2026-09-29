import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { QueueConsumer } from "../messaging/queue-consumer";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { nerisClientPolicyStatements } from "../neris/neris-config";
import { IamPolicyStatement } from "../observability/observability-policy";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface IncidentArgs {
  env: string;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  nerisSchemaBucketArn: pulumi.Input<string>;
  nerisSchemaBucketName: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  /** NERIS OAuth client secret: only the routes that call NERIS (validate, lock, no-activity) read it. */
  nerisCredentialsSecretArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

const CMK_STATEMENT = (cmkArn: pulumi.Input<string>) =>
  pulumi.output(cmkArn).apply((arn) => [
    {
      Sid: "IncidentCmkAccess" as const,
      Effect: "Allow" as const,
      Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      Resource: [arn],
    },
  ]);

const SCHEMA_S3_READ_STATEMENT = (bucketArn: pulumi.Input<string>) =>
  pulumi.output(bucketArn).apply((arn) => [
    {
      Sid: "ReadNerisSchemaPins" as const,
      Effect: "Allow" as const,
      Action: ["s3:GetObject"],
      Resource: [`${arn}/neris-schema/*`],
    },
  ]);

/**
 * incident-service HTTP routes, dispatch-copy projection consumers, and their
 * scoped IAM (E6-S2-INFRA #237, E6-S4-INFRA #239, E6-S5-INFRA #240,
 * E6-S6-INFRA #241, E6-S10-INFRA #245). No incident-service Lambda here holds
 * any grant on the platform-service or alerting-service tables (issue AC).
 *
 * E6-S3-INFRA #238 (guided-completion write route) deploys VPC-less: its
 * handler (updateIncident.ts) resolves the active schema straight from
 * DynamoDB/S3, with no Valkey client in the backend to attach to — the
 * ticket's VPC + Valkey ingress scope depends on E8-S4-INFRA, which does not
 * exist in this repo yet, so there is no VPC to join.
 *
 * E6-S6-INFRA #241's Cedar exposure policy (reads/writes on INCIDENT_SECONDARY
 * narrowed to the affected member, chief, and safety officer) is not written:
 * "safety officer" is not one of the six Cedar role groups the policy store
 * provisions (authz/cedar-policies.ts ROLE_GROUPS), and the ticket's own
 * "Current state" section says that mapping decision has to be made first.
 * The route, Lambda, and table/CMK/S3 IAM below are wired regardless.
 */
export class Incident extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly updateLambda: ServiceLambda;
  public readonly narrativeLambda: ServiceLambda;
  public readonly responseTimesLambda: ServiceLambda;
  public readonly exposuresLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly searchLambda: ServiceLambda;
  public readonly submitLambda: ServiceLambda;
  public readonly submissionGetLambda: ServiceLambda;
  public readonly submissionRetryLambda: ServiceLambda;
  public readonly dispatchAlertConsumer: QueueConsumer;
  public readonly dispatchResponseConsumer: QueueConsumer;
  public readonly nerisRouteLambdas: Record<string, ServiceLambda> = {};
  public readonly nerisSettingsConsumer: QueueConsumer;

  constructor(name: string, args: IncidentArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Incident", args.env);
    super("boxalarm:incident:Incident", name, {}, opts);
    const { env } = args;

    const baseEnvironment = { INCIDENT_TABLE_NAME: args.incidentTableName };
    const cmkStatement = CMK_STATEMENT(args.incidentCmkArn);
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "create"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              Sid: "IncidentCreateAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:PutItem",
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
              ],
              Resource: [tableArn, `${tableArn}/index/*`],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      { routeKey: "POST /api/v1/incidents", lambda: this.createLambda },
      { parent: this },
    );

    this.updateLambda = new ServiceLambda(
      `${name}-update`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-update`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "update"),
        logGroup: args.logGroup,
        environment: { ...baseEnvironment, NERIS_SCHEMA_BUCKET_NAME: args.nerisSchemaBucketName },
        additionalPolicyStatements: pulumi
          .all([
            cmkStatement,
            vpStatement,
            SCHEMA_S3_READ_STATEMENT(args.nerisSchemaBucketArn),
            args.incidentTableArn,
          ])
          .apply(([cmk, vp, s3, tableArn]) => [
            {
              // PutItem: the incident.updated OUTBOX_ENTRY committed with the update.
              Sid: "IncidentUpdateAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetItem",
                "dynamodb:UpdateItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
            ...s3,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-route`,
      { routeKey: "PUT /api/v1/incidents/{incidentId}", lambda: this.updateLambda },
      { parent: this },
    );

    this.narrativeLambda = new ServiceLambda(
      `${name}-narrative`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-narrative`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "narrative"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              // PutItem: the incident.narrative.updated OUTBOX_ENTRY committed with the update.
              Sid: "IncidentNarrativeAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-narrative-route`,
      { routeKey: "PUT /api/v1/incidents/{incidentId}/narrative", lambda: this.narrativeLambda },
      { parent: this },
    );

    this.responseTimesLambda = new ServiceLambda(
      `${name}-response-times`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-response-times`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "response-times"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              // ConditionCheckItem: parent-incident existence check inside the transaction;
              // GetItem: read-back of the committed RESPONSE# row; PutItem: the
              // incident.response_unit.updated OUTBOX_ENTRY.
              Sid: "IncidentResponseTimesAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:ConditionCheckItem",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-response-times-route`,
      {
        routeKey: "PUT /api/v1/incidents/{incidentId}/response-times",
        lambda: this.responseTimesLambda,
      },
      { parent: this },
    );

    this.exposuresLambda = new ServiceLambda(
      `${name}-exposures`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-exposures`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "exposures"),
        logGroup: args.logGroup,
        environment: { ...baseEnvironment, NERIS_SCHEMA_BUCKET_NAME: args.nerisSchemaBucketName },
        additionalPolicyStatements: pulumi
          .all([
            cmkStatement,
            vpStatement,
            SCHEMA_S3_READ_STATEMENT(args.nerisSchemaBucketArn),
            args.incidentTableArn,
          ])
          .apply(([cmk, vp, s3, tableArn]) => [
            {
              // ConditionCheckItem: the parent report must exist and not be locked, checked
              // inside the module's write transaction (secondaryRepository.ts, lock.ts).
              Sid: "IncidentExposuresAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
                "dynamodb:GetItem",
                "dynamodb:ConditionCheckItem",
              ],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
            ...s3,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-exposures-route`,
      { routeKey: "PUT /api/v1/incidents/{incidentId}/exposures", lambda: this.exposuresLambda },
      { parent: this },
    );

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "get"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              Sid: "IncidentGetAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:Query"],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/incidents/{incidentId}", lambda: this.getLambda },
      { parent: this },
    );

    this.searchLambda = new ServiceLambda(
      `${name}-search`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-search`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "search"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        // No dynamodb:Scan (AC1) — searchIncidents.ts queries GSI1 only.
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              Sid: "IncidentSearchAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [`${tableArn}/index/GSI1`],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-search-route`,
      { routeKey: "GET /api/v1/incidents", lambda: this.searchLambda },
      { parent: this },
    );

    // F7.6/F7.7 NERIS submission routes (architecture.md route table). submit.ts and
    // retrySubmission.ts each run one transaction - Update the incident METADATA plus Put
    // the neris.incident.submitted OUTBOX_ENTRY - then GetItem to explain a failed
    // condition; getSubmission.ts is a single consistent GetItem. Role gating is the
    // handlers' authorizer-group check (submit: ADMIN/CHIEF; status and retry: OFFICER and
    // up), not Cedar, so no Verified Permissions grant.
    const submissionRoutes = [
      {
        key: "submit",
        fn: "submit",
        routeKey: "POST /api/v1/incidents/{incidentId}/submit",
        actions: ["dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:GetItem"],
      },
      {
        key: "submission-get",
        fn: "submission-get",
        routeKey: "GET /api/v1/incidents/{incidentId}/submission",
        // Query: the ledger's SUBMISSION# attempts and NERIS#STATUS# history rows.
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
      },
      {
        key: "submission-retry",
        fn: "submission-retry",
        routeKey: "POST /api/v1/incidents/{incidentId}/submission/retry",
        actions: ["dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:GetItem"],
      },
    ] as const;
    const submissionLambdas = submissionRoutes.map((route) => {
      const lambda = new ServiceLambda(
        `${name}-${route.key}`,
        {
          env,
          serviceName: "incident-service",
          functionName: `boxalarm-${env}-incident-${route.key}`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("incident-service", route.fn),
          logGroup: args.logGroup,
          environment: baseEnvironment,
          additionalPolicyStatements: pulumi
            .all([cmkStatement, args.incidentTableArn])
            .apply(([cmk, tableArn]) => [
              {
                Sid: "IncidentSubmissionAccess" as const,
                Effect: "Allow" as const,
                Action: [...route.actions],
                Resource: [tableArn],
              },
              ...cmk,
            ]),
        },
        { parent: this },
      );
      args.httpApi.route(
        `${name}-${route.key}-route`,
        { routeKey: route.routeKey, lambda },
        { parent: this },
      );
      return lambda;
    });
    [this.submitLambda, this.submissionGetLambda, this.submissionRetryLambda] =
      submissionLambdas as [ServiceLambda, ServiceLambda, ServiceLambda];

    // The submission ledger (attempts + NERIS status history, reviewRepository.ts
    // querySubmissionLedger) is served by the same Lambda under the plural path too.
    args.httpApi.route(
      `${name}-submissions-route`,
      {
        routeKey: "GET /api/v1/incidents/{incidentId}/submissions",
        lambda: this.submissionGetLambda,
      },
      { parent: this },
    );

    // NERIS loop routes (validate, review lock/unlock, resubmit, no-activity month). Each is
    // Cedar-gated in its handler (withAuthorization, Boxalarm::Incident / ::Department), so
    // each gets the policy-store id and the IsAuthorized grant. Only the routes that call
    // NERIS read the OAuth secret; only the ones that judge a report read the schema pins.
    const nerisEnvironment = {
      NERIS_BASE_URL_PARAM: `/boxalarm/${env}/neris/base-url`,
      NERIS_USER_AGENT_PARAM: `/boxalarm/${env}/neris/user-agent`,
      NERIS_CREDENTIALS_SECRET_ID: args.nerisCredentialsSecretArn,
      // neris/config.ts decides prod vs non-prod from STAGE ?? BOXALARM_ENV (N6.4).
      BOXALARM_ENV: env,
    };
    const nerisRoutes: {
      key: string;
      routeKey: string;
      actions: string[];
      gsi1?: boolean;
      neris: boolean;
      schema: boolean;
    }[] = [
      {
        // Report + settings copy + RESPONSE# rows + schema pointer: reads only.
        key: "validate",
        routeKey: "POST /api/v1/incidents/{incidentId}/validate",
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        neris: true,
        schema: true,
      },
      {
        // Reads as validate, then one transaction: METADATA Update + audit and outbox Puts.
        key: "lock",
        routeKey: "POST /api/v1/incidents/{incidentId}/lock",
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem"],
        neris: true,
        schema: true,
      },
      {
        key: "unlock",
        routeKey: "POST /api/v1/incidents/{incidentId}/unlock",
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
        neris: false,
        schema: false,
      },
      {
        // Builds the payload locally for the diff; the worker makes the NERIS PUT.
        key: "resubmit",
        routeKey: "POST /api/v1/incidents/{incidentId}/resubmit",
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem"],
        neris: false,
        schema: true,
      },
      {
        // Month's incident count on GSI1, then the filed-month row + outbox Puts.
        key: "no-activity-report",
        routeKey: "POST /api/v1/incidents/no-activity-reports",
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
        gsi1: true,
        neris: true,
        schema: false,
      },
    ];
    for (const route of nerisRoutes) {
      const lambda = new ServiceLambda(
        `${name}-${route.key}`,
        {
          env,
          serviceName: "incident-service",
          functionName: `boxalarm-${env}-incident-${route.key}`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("incident-service", route.key),
          logGroup: args.logGroup,
          // A NERIS round trip (token + /validate or /no_activity_report) on a cold start.
          ...(route.neris ? { timeout: 20 } : {}),
          environment: {
            ...baseEnvironment,
            VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
            ...(route.schema ? { NERIS_SCHEMA_BUCKET_NAME: args.nerisSchemaBucketName } : {}),
            ...(route.neris ? nerisEnvironment : {}),
          },
          additionalPolicyStatements: pulumi
            .all([
              cmkStatement,
              vpStatement,
              SCHEMA_S3_READ_STATEMENT(args.nerisSchemaBucketArn),
              args.incidentTableArn,
              args.nerisCredentialsSecretArn,
            ])
            .apply(([cmk, vp, s3, tableArn, secretArn]) => {
              const statements: IamPolicyStatement[] = [
                {
                  Sid: "IncidentNerisRouteAccess",
                  Effect: "Allow",
                  Action: route.actions,
                  Resource: route.gsi1 ? [tableArn, `${tableArn}/index/GSI1`] : [tableArn],
                },
                ...cmk,
                ...vp,
              ];
              if (route.schema) statements.push(...s3);
              if (route.neris) statements.push(...nerisClientPolicyStatements(secretArn, env));
              return statements;
            }),
        },
        { parent: this },
      );
      args.httpApi.route(
        `${name}-${route.key}-route`,
        { routeKey: route.routeKey, lambda },
        { parent: this },
      );
      this.nerisRouteLambdas[route.key] = lambda;
    }

    // incident-service's copy of the department NERIS settings and unit ids (owned by
    // platform-service; this service holds no platform-table grant): PutItem only.
    const nerisSettingsLambda = new ServiceLambda(
      `${name}-neris-settings-consumer`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-neris-settings-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "neris-settings-consumer"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, args.incidentTableArn])
          .apply(([cmk, tableArn]) => [
            {
              Sid: "IncidentNerisSettingsCopyAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem"],
              Resource: [tableArn],
            },
            ...cmk,
          ]),
      },
      { parent: this },
    );
    this.nerisSettingsConsumer = new QueueConsumer(
      `${name}-neris-settings-consumer`,
      {
        env,
        busName: args.busName,
        busArn: args.busArn,
        ruleName: `boxalarm-${env}-incident-neris-settings-copy`,
        eventPattern: JSON.stringify({
          source: ["platform-service"],
          "detail-type": ["platform.config.updated", "neris.entity.synced"],
        }),
        queueName: `boxalarm-${env}-incident-neris-settings-copy-queue`,
        lambda: nerisSettingsLambda.function,
        lambdaRole: nerisSettingsLambda.role,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
      },
      { parent: this },
    );

    // #237: dispatch/roster projection consumers off the alerting-plane bridge
    // (dispatch.alert.received, alerting.response.confirmed republished onto
    // boxalarm-{env}-platform-bus by another story). One QueueConsumer per
    // backend handler file rather than the ticket's single named queue — both
    // are DLQ-alarmed and IAM-scoped the same as a single queue would be.
    const dispatchAlertLambda = new ServiceLambda(
      `${name}-dispatch-alert-consumer`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-dispatch-alert-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "dispatch-alert-consumer"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, args.incidentTableArn])
          .apply(([cmk, tableArn]) => [
            {
              Sid: "IncidentDispatchAlertCopyAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem"],
              Resource: [tableArn],
            },
            ...cmk,
          ]),
      },
      { parent: this },
    );
    this.dispatchAlertConsumer = new QueueConsumer(
      `${name}-dispatch-alert-consumer`,
      {
        env,
        busName: args.busName,
        busArn: args.busArn,
        ruleName: `boxalarm-${env}-incident-dispatch-alert-copy`,
        eventPattern: JSON.stringify({ "detail-type": ["dispatch.alert.received"] }),
        queueName: `boxalarm-${env}-incident-dispatch-alert-copy-queue`,
        lambda: dispatchAlertLambda.function,
        lambdaRole: dispatchAlertLambda.role,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
      },
      { parent: this },
    );

    const dispatchResponseLambda = new ServiceLambda(
      `${name}-dispatch-response-consumer`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-dispatch-response-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "dispatch-response-consumer"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, args.incidentTableArn])
          .apply(([cmk, tableArn]) => [
            {
              Sid: "IncidentDispatchRosterCopyAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem", "dynamodb:GetItem"],
              Resource: [tableArn],
            },
            ...cmk,
          ]),
      },
      { parent: this },
    );
    this.dispatchResponseConsumer = new QueueConsumer(
      `${name}-dispatch-response-consumer`,
      {
        env,
        busName: args.busName,
        busArn: args.busArn,
        ruleName: `boxalarm-${env}-incident-dispatch-response-copy`,
        eventPattern: JSON.stringify({ "detail-type": ["alerting.response.confirmed"] }),
        queueName: `boxalarm-${env}-incident-dispatch-response-copy-queue`,
        lambda: dispatchResponseLambda.function,
        lambdaRole: dispatchResponseLambda.role,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
      },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      updateLambda: this.updateLambda,
      narrativeLambda: this.narrativeLambda,
      responseTimesLambda: this.responseTimesLambda,
      exposuresLambda: this.exposuresLambda,
      getLambda: this.getLambda,
      searchLambda: this.searchLambda,
      submitLambda: this.submitLambda,
      submissionGetLambda: this.submissionGetLambda,
      submissionRetryLambda: this.submissionRetryLambda,
    });
  }
}
