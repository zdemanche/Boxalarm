import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { SERVICES } from "../../components/observability/services";

describe("index.ts production wiring", () => {
  let counts: Record<string, number>;
  let logGroupNames: Set<string>;
  let dashboardNames: Set<string>;

  beforeEach(async () => {
    vi.resetModules();
    counts = {};
    logGroupNames = new Set();
    dashboardNames = new Set();
    await pulumi.runtime.setMocks(
      {
        newResource: (args: pulumi.runtime.MockResourceArgs) => {
          counts[args.type] = (counts[args.type] ?? 0) + 1;
          const state: Record<string, unknown> = { ...args.inputs };
          if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
            logGroupNames.add(args.inputs.name as string);
            state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
          }
          if (args.type === "aws:cloudwatch/dashboard:Dashboard") {
            dashboardNames.add(args.inputs.dashboardName as string);
          }
          if (args.type === "aws:iam/role:Role") {
            state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
          }
          if (args.type === "aws:lambda/function:Function") {
            const name = (args.inputs.name as string) ?? args.name;
            state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${name}`;
            state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${state.arn}/invocations`;
          }
          if (args.type === "aws:kms/key:Key") {
            state.arn = `arn:aws:kms:us-east-1:123456789012:key/${args.name}`;
          }
          if (args.type === "aws:dynamodb/table:Table") {
            state.arn = `arn:aws:dynamodb:us-east-1:123456789012:table/${args.inputs.name}`;
            state.streamArn = `${state.arn}/stream/2026-01-01T00:00:00.000`;
          }
          if (args.type === "aws:apigatewayv2/api:Api") {
            state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
            state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
          }
          if (args.type === "aws:secretsmanager/secret:Secret") {
            state.arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${args.name}`;
          }
          if (args.type === "aws:s3/bucket:Bucket") {
            state.arn = `arn:aws:s3:::${args.inputs.bucket ?? args.name}`;
            state.bucket = args.inputs.bucket ?? args.name;
          }
          if (args.type === "aws:cognito/userPool:UserPool") {
            state.arn = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${args.name}`;
          }
          if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
            state.policyStoreId = `${args.name}-id`;
            state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}-id`;
          }
          if (args.type === "aws:cloudwatch/eventBus:EventBus") {
            state.arn = `arn:aws:events:us-east-1:123456789012:event-bus/${args.inputs.name}`;
          }
          if (args.type === "aws:sqs/queue:Queue") {
            state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
          }
          if (args.type === "aws:sns/topic:Topic") {
            state.arn = `arn:aws:sns:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
          }
          return { id: `${args.name}-id`, state };
        },
        call: (args: pulumi.runtime.MockCallArgs) => {
          if (args.token === "aws:index/getRegion:getRegion") {
            return {
              name: "us-east-1",
              region: "us-east-1",
              id: "us-east-1",
              description: "US East (N. Virginia)",
              endpoint: "",
            };
          }
          if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
            return {
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:root",
              userId: "AIDATEST",
            };
          }
          return args.inputs;
        },
      },
      "boxalarm-infra",
      "dev",
    );
    pulumi.runtime.setAllConfig({
      "boxalarm-infra:env": "dev",
      "boxalarm-infra:webOrigin": "https://localhost:5173",
      "boxalarm-infra:deptId": "nichols-fd",
    });
  });

  it("provisions observability, identity, HTTP API, tables, audit trail, and NERIS config", async () => {
    const indexModule = await import("../../index");
    await new Promise<void>((resolve) =>
      pulumi.all(indexModule.serviceLogGroups.map((g) => g.logGroup.urn)).apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      pulumi.all(indexModule.serviceDashboards.map((d) => d.dashboard.urn)).apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      indexModule.defaultSamplingRule.urn.apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      indexModule.alertingSamplingRule.urn.apply(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      pulumi
        .all([
          indexModule.identity.userPool.id,
          indexModule.identity.userPoolDomain.domain,
          indexModule.identity.preTokenGenerationFunction.arn,
          indexModule.identity.functionRole.arn,
          indexModule.identity.functionLogGroup.arn,
          indexModule.identity.invokePermission.id,
          indexModule.mobileUserPoolClient.userPoolClient.id,
          indexModule.webUserPoolClient.userPoolClient.id,
          indexModule.httpApi.httpApi.id,
          indexModule.httpApi.authorizer.id,
          indexModule.httpApi.authorizerLambda.function.arn,
          indexModule.httpApi.stage.id,
          indexModule.httpApi.accessLogGroup.arn,
          indexModule.platformTable.table.arn,
          indexModule.incidentTable.table.arn,
          indexModule.alertingTable.table.arn,
          indexModule.auditTrail.trail.id,
          indexModule.nerisConfig.secret.arn,
          indexModule.policyStore.policyStoreId,
          indexModule.platformBus.busName,
          indexModule.outboxPublisher.lambda.function.arn,
          indexModule.sessionRevocation.memberStatusLambda.function.arn,
          indexModule.sessionRevocation.deviceLossLambda.function.arn,
          indexModule.recoveryMonitor.trail.id,
          indexModule.personnelMembers.createLambda.function.arn,
          indexModule.personnelMembers.updateProfileLambda.function.arn,
          indexModule.personnelQuals.getLambda.function.arn,
          indexModule.personnelAttendance.recordLambda.function.arn,
          indexModule.personnelAvailability.createLambda.function.arn,
          indexModule.personnelLosap.getMemberTotalLambda.function.arn,
          indexModule.personnelShifts.lambda.function.arn,
          indexModule.trainingCertifications.createLambda.function.arn,
          indexModule.trainingCertifications.scannerLambda.function.arn,
          indexModule.trainingEvents.createLambda.function.arn,
          indexModule.trainingHours.lambda.function.arn,
          indexModule.trainingReports.isoLambda.function.arn,
          indexModule.trainingTranscript.getLambda.function.arn,
          indexModule.platformConfig.lambda.function.arn,
          indexModule.auditRoute.lambda.function.arn,
          indexModule.chiefNotificationTopic.topicArn,
          indexModule.platformExport.handlerLambda.function.arn,
          indexModule.platformRetention.disposalLambda.function.arn,
        ])
        .apply(() => resolve()),
    );

    // 10 services + identity pre-token-generation trigger + HTTP API access logs.
    expect(counts["aws:cloudwatch/logGroup:LogGroup"]).toBe(12);
    expect(counts["aws:cloudwatch/dashboard:Dashboard"]).toBe(10);
    expect(counts["aws:xray/samplingRule:SamplingRule"]).toBe(2);
    expect(counts["aws:dynamodb/table:Table"]).toBe(3);
    expect(counts["aws:apigatewayv2/api:Api"]).toBe(1);
    expect(indexModule.stack).toBe("dev");
    expect(indexModule.env).toBe("dev");
    expect(indexModule.webOrigin).toBe("https://localhost:5173");

    // ServiceLambda authorizer consumes ACTIVE_TRACING_CONFIG + observabilityPolicyStatements.
    const authorizerTracing = await new Promise((resolve) =>
      indexModule.httpApi.authorizerLambda.function.tracingConfig.apply(resolve),
    );
    expect(authorizerTracing).toEqual({ mode: "Active" });

    const expectedLogGroupNames = new Set([
      ...SERVICES.map((serviceName) => `/aws/lambda/boxalarm-dev-${serviceName}`),
      "/aws/lambda/boxalarm-dev-identity-pre-token-generation",
      "/aws/apigateway/boxalarm-dev-http-api-access",
    ]);
    const expectedDashboardNames = new Set(
      SERVICES.map((serviceName) => `boxalarm-dev-${serviceName}`),
    );
    expect(logGroupNames).toEqual(expectedLogGroupNames);
    expect(dashboardNames).toEqual(expectedDashboardNames);
  }, 20000);

  it("throws when the boxalarm-infra:env config key is not declared", async () => {
    pulumi.runtime.setAllConfig({});
    await expect(import("../../index")).rejects.toThrow(/boxalarm-infra:env/);
  });
});
