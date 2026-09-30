import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        const name = (args.inputs.name as string) ?? args.name;
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${name}`;
        state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${state.arn}/invocations`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", description: "US East (N. Virginia)", id: "us-east-1" };
      }
      return args.inputs;
    },
  });
});

// FileAsset + nested ServiceLambda registerOutputs can resolve after assertions;
// give the mock monitor a turn to finish before beforeEach swaps it out.
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function settle(api: {
  urn: pulumi.Output<string>;
  httpApi: {
    id: pulumi.Output<string>;
    apiEndpoint: pulumi.Output<string>;
    executionArn: pulumi.Output<string>;
  };
  authorizer: { id: pulumi.Output<string>; authorizerUri: pulumi.Output<string | undefined> };
  stage: {
    id: pulumi.Output<string>;
    name: pulumi.Output<string>;
    defaultRouteSettings: pulumi.Output<
      { throttlingRateLimit?: number; throttlingBurstLimit?: number } | undefined
    >;
    accessLogSettings: pulumi.Output<{ destinationArn?: string; format?: string } | undefined>;
  };
  accessLogGroup: { id: pulumi.Output<string>; arn: pulumi.Output<string> };
  invokePermission: { id: pulumi.Output<string>; sourceArn: pulumi.Output<string | undefined> };
  authorizerLambda: {
    urn: pulumi.Output<string>;
    function: {
      arn: pulumi.Output<string>;
      invokeArn: pulumi.Output<string>;
      name: pulumi.Output<string>;
      environment: pulumi.Output<{ variables?: Record<string, string> } | undefined>;
    };
    role: { arn: pulumi.Output<string> };
    rolePolicy: { id: pulumi.Output<string> };
  };
  apiEndpoint: pulumi.Output<string>;
}): Promise<void> {
  await Promise.all([
    resolve(api.urn),
    resolve(api.httpApi.id),
    resolve(api.httpApi.apiEndpoint),
    resolve(api.httpApi.executionArn),
    resolve(api.authorizer.id),
    resolve(api.authorizer.authorizerUri as pulumi.Output<string>),
    resolve(api.stage.id),
    resolve(api.stage.name),
    resolve(api.stage.defaultRouteSettings),
    resolve(api.stage.accessLogSettings),
    resolve(api.accessLogGroup.id),
    resolve(api.accessLogGroup.arn),
    resolve(api.invokePermission.id),
    resolve(api.invokePermission.sourceArn as pulumi.Output<string>),
    resolve(api.authorizerLambda.urn),
    resolve(api.authorizerLambda.function.arn),
    resolve(api.authorizerLambda.function.invokeArn),
    resolve(api.authorizerLambda.function.name),
    resolve(api.authorizerLambda.function.environment),
    resolve(api.authorizerLambda.role.arn),
    resolve(api.authorizerLambda.rolePolicy.id),
    resolve(api.apiEndpoint),
  ]);
  await new Promise((r) => setImmediate(r));
}

describe("HttpApi", () => {
  it("creates an HTTP API with a fail-closed REQUEST Lambda authorizer (payload 2.0)", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-api", {
      env: "dev",
      serviceName: "platform-service",
    });

    const api = new HttpApi("http-api", {
      env: "dev",
      userPoolId: "us-east-1_pool",
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: ["web-client-id", "mobile-client-id"],
      platformLogGroup: logGroup,
      cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
    });
    await settle(api);

    const [
      apiName,
      protocolType,
      authorizerName,
      authorizerType,
      payloadFormat,
      identitySources,
      enableSimpleResponses,
      authorizerUri,
      invokeArn,
      stageName,
      autoDeploy,
      defaultRouteSettings,
      principal,
      action,
      fnName,
      envVars,
      reservedConcurrentExecutions,
      authorizerResultTtlInSeconds,
      invokePermissionSourceArn,
      executionArn,
      accessLogSettings,
      accessLogGroupName,
    ] = await Promise.all([
      resolve(api.httpApi.name),
      resolve(api.httpApi.protocolType),
      resolve(api.authorizer.name),
      resolve(api.authorizer.authorizerType),
      resolve(api.authorizer.authorizerPayloadFormatVersion),
      resolve(api.authorizer.identitySources),
      resolve(api.authorizer.enableSimpleResponses),
      resolve(api.authorizer.authorizerUri as pulumi.Output<string>),
      resolve(api.authorizerLambda.function.invokeArn),
      resolve(api.stage.name),
      resolve(api.stage.autoDeploy),
      resolve(api.stage.defaultRouteSettings),
      resolve(api.invokePermission.principal),
      resolve(api.invokePermission.action),
      resolve(api.authorizerLambda.function.name),
      resolve(api.authorizerLambda.function.environment),
      resolve(api.authorizerLambda.function.reservedConcurrentExecutions),
      resolve(api.authorizer.authorizerResultTtlInSeconds),
      resolve(api.invokePermission.sourceArn as pulumi.Output<string>),
      resolve(api.httpApi.executionArn),
      resolve(api.stage.accessLogSettings),
      resolve(api.accessLogGroup.name),
    ]);

    expect(apiName).toBe("boxalarm-dev-http-api");
    expect(protocolType).toBe("HTTP");
    expect(authorizerType).toBe("REQUEST");
    expect(payloadFormat).toBe("2.0");
    expect(identitySources).toEqual(["$request.header.Authorization"]);
    expect(enableSimpleResponses).toBe(true);
    expect(authorizerUri).toBe(invokeArn);
    expect(stageName).toBe("$default");
    expect(autoDeploy).toBe(true);
    // Every request hits the authorizer Lambda uncached — the stage must throttle so
    // an unauthenticated flood can't exhaust the account's shared concurrency pool.
    expect(defaultRouteSettings?.throttlingRateLimit).toBe(50);
    expect(defaultRouteSettings?.throttlingBurstLimit).toBe(100);
    expect(reservedConcurrentExecutions).toBe(20);
    // Load-bearing: never cache an allow decision from this fail-closed stub (source
    // comment on the authorizer). A later edit setting this to e.g. 300 must fail here.
    expect(authorizerResultTtlInSeconds).toBe(0);
    // Scoped to this API's authorizers, not a bare wildcard.
    expect(invokePermissionSourceArn).toBe(`${executionArn}/authorizers/*`);
    // With a fail-closed authorizer denying every request, operators need a caller
    // activity record — status, route, and authorizer error at minimum.
    expect(accessLogGroupName).toBe("/aws/apigateway/boxalarm-dev-http-api-access");
    expect(accessLogSettings?.destinationArn).toBeDefined();
    const accessLogFormat = JSON.parse(accessLogSettings?.format ?? "{}");
    expect(accessLogFormat).toMatchObject({
      requestId: expect.stringContaining("requestId"),
      status: expect.stringContaining("status"),
      routeKey: expect.stringContaining("routeKey"),
      integrationErrorMessage: expect.stringContaining("integrationErrorMessage"),
      authorizerError: expect.stringContaining("authorizer.error"),
    });
    expect(principal).toBe("apigateway.amazonaws.com");
    expect(action).toBe("lambda:InvokeFunction");
    expect(fnName).toBe("boxalarm-dev-platform-authorizer");
    // The bundle's handler string: the backend authorizer when bundled, else the deny stub
    // (served as index.js under the same handler) - never the old stub-only wiring.
    expect(await resolve(api.authorizerLambda.function.handler)).toBe("index.handler");
    expect(envVars?.variables?.COGNITO_USER_POOL_ID).toBe("us-east-1_pool");
    expect(envVars?.variables?.COGNITO_ISSUER).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
    );
    expect(envVars?.variables?.COGNITO_ALLOWED_CLIENT_IDS).toBe("web-client-id,mobile-client-id");
    expect(envVars?.variables?.SERVICE_NAME).toBe("platform-service");
    expect(authorizerName).toBe("boxalarm-dev-http-authorizer");

    const endpoint = await resolve(api.apiEndpoint);
    expect(endpoint).toContain("execute-api");
  });

  // Review M1: access tokens are verified offline and live an hour after a sign-out; the
  // authorizer refuses tokens issued before the member's revocation marker.
  it("gives the authorizer the revocation-marker table and a read of the marker keys only", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-revocation", {
      env: "dev",
      serviceName: "platform-service",
    });
    const api = new HttpApi("http-api-revocation", {
      env: "dev",
      userPoolId: "us-east-1_pool",
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: ["web-client-id"],
      platformLogGroup: logGroup,
    });
    await settle(api);

    const [envVars, policy] = await Promise.all([
      resolve(api.authorizerLambda.function.environment),
      resolve(api.authorizerLambda.rolePolicy.policy),
    ]);
    expect(envVars?.variables?.PLATFORM_TABLE_NAME).toBe("platform-table");
    const statements = (JSON.parse(policy) as { Statement: Array<Record<string, unknown>> })
      .Statement;
    const dynamo = statements.filter((st) => JSON.stringify(st.Action).includes("dynamodb:"));
    expect(dynamo).toEqual([
      {
        Sid: "ReadSessionRevocationMarkers",
        Effect: "Allow",
        Action: ["dynamodb:GetItem"],
        Resource: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#SESSION_REVOCATION#*"] },
        },
      },
    ]);
  });

  // Review M4: one shared stage throttle and one authorizer concurrency pool let a flood of
  // junk tokens on any route starve manual dispatch and responding to a call.
  describe("reserved alerting capacity (M4)", () => {
    async function buildApi(suffix: string) {
      const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
      const { HttpApi } = await import("../../components/api/http-api");
      const logGroup = new ServiceLogGroup(`platform-log-group-m4-${suffix}`, {
        env: "dev",
        serviceName: "platform-service",
      });
      const api = new HttpApi(`http-api-m4-${suffix}`, {
        env: "dev",
        userPoolId: "us-east-1_pool",
        platformTableName: "platform-table",
        platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
        allowedClientIds: ["web-client-id"],
        platformLogGroup: logGroup,
      });
      return api;
    }

    it("routes the reserved alerting routes through their own authorizer with its own concurrency", async () => {
      const { ALERTING_PLANE_ROUTES } = await import("../../components/api/http-api");
      const api = await buildApi("authorizer");
      const reserved = api.authorizedRoute("respond", {
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/responses",
      });
      const other = api.authorizedRoute("roster", { routeKey: "GET /api/v1/personnel/members" });
      api.sealRouteSettings();

      const [reservedAuth, otherAuth, alertingId, mainId, reservedConcurrency, fnName, env] =
        await Promise.all([
          resolve(reserved.authorizerId as pulumi.Output<string>),
          resolve(other.authorizerId as pulumi.Output<string>),
          resolve(api.alertingAuthorizer.id),
          resolve(api.authorizer.id),
          resolve(api.alertingAuthorizerLambda.function.reservedConcurrentExecutions),
          resolve(api.alertingAuthorizerLambda.function.name),
          resolve(api.alertingAuthorizerLambda.function.environment),
        ]);
      expect(reservedAuth).toBe(alertingId);
      expect(otherAuth).toBe(mainId);
      expect(alertingId).not.toBe(mainId);
      expect(reservedConcurrency).toBe(20);
      expect(fnName).toBe("boxalarm-dev-platform-authorizer-alerting");
      // Same verification and revocation check as the main authorizer.
      expect(env?.variables?.PLATFORM_TABLE_NAME).toBe("platform-table");
      expect(Object.keys(ALERTING_PLANE_ROUTES)).toContain(
        "POST /api/v1/alerting/dispatches/{dispatchId}/responses",
      );
      await settle(api);
    });

    // Review of fix/access-control, MAJOR 1: every alerting-plane route must fail open on a
    // revocation-store outage, so every one must sit on the alerting authorizer.
    it("runs the alerting authorizer with REVOCATION_CHECK_FAIL_OPEN and covers the whole alerting plane", async () => {
      const { ALERTING_PLANE_ROUTES } = await import("../../components/api/http-api");
      const api = await buildApi("fail-open");
      const env = await resolve(api.alertingAuthorizerLambda.function.environment);
      const mainEnv = await resolve(api.authorizerLambda.function.environment);

      expect(env?.variables?.REVOCATION_CHECK_FAIL_OPEN).toBe("true");
      expect(mainEnv?.variables?.REVOCATION_CHECK_FAIL_OPEN).toBeUndefined();
      expect(Object.keys(ALERTING_PLANE_ROUTES)).toEqual(
        expect.arrayContaining([
          "POST /api/v1/alerting/dispatches",
          "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance",
          "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/halt",
          "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger",
          "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/acknowledge",
          "POST /api/v1/apparatus/riding-board/{dispatchId}/assignments",
          "POST /api/v1/personnel/members/{memberId}/push-tokens",
        ]),
      );
      api.sealRouteSettings();
      await settle(api);
    });

    // Security-web MINOR 8: officer delivery-evidence reads fail closed on the main authorizer.
    it("keeps the officer alerting read routes off the fail-open authorizer", async () => {
      const { ALERTING_PLANE_ROUTES, OFFICER_ALERTING_READ_ROUTES } =
        await import("../../components/api/http-api");
      expect(OFFICER_ALERTING_READ_ROUTES.length).toBe(6);
      for (const routeKey of OFFICER_ALERTING_READ_ROUTES) {
        expect(Object.keys(ALERTING_PLANE_ROUTES)).not.toContain(routeKey);
      }
      const api = await buildApi("officer-reads");
      const receipts = api.authorizedRoute("receipts", {
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/receipts",
      });
      const [authorizerId, mainId] = await Promise.all([
        resolve(receipts.authorizerId as pulumi.Output<string>),
        resolve(api.authorizer.id),
      ]);
      expect(authorizerId).toBe(mainId);
      api.sealRouteSettings();
      await settle(api);
    });

    // Review MAJOR 3: a reserved limit below the default made the flood cheaper, not dearer.
    it("never throttles an alerting-plane route below the stage default", async () => {
      const { ALERTING_PLANE_ROUTES } = await import("../../components/api/http-api");
      for (const [routeKey, limit] of Object.entries(ALERTING_PLANE_ROUTES)) {
        expect(limit.rateLimit, routeKey).toBeGreaterThanOrEqual(50);
        expect(limit.burstLimit, routeKey).toBeGreaterThanOrEqual(100);
      }
    });

    it("pages alerting-page on any throttle or error of the alerting authorizer", async () => {
      const api = await buildApi("throttles-alarm");
      api.sealRouteSettings();
      const { alertingAuthorizerThrottles, alertingAuthorizerErrors } = api.addAlarms(
        "arn:aws:sns:us-east-1:1:chief",
        "arn:aws:sns:us-east-1:1:alerting-page",
      );
      const [metric, namespace, dimensions, fnName, threshold, actions, errorsActions] =
        await Promise.all([
          resolve(alertingAuthorizerThrottles.metricName),
          resolve(alertingAuthorizerThrottles.namespace),
          resolve(alertingAuthorizerThrottles.dimensions),
          resolve(api.alertingAuthorizerLambda.function.name),
          resolve(alertingAuthorizerThrottles.threshold),
          resolve(alertingAuthorizerThrottles.alarmActions),
          resolve(alertingAuthorizerErrors.alarmActions),
        ]);
      expect([metric, namespace, threshold]).toEqual(["Throttles", "AWS/Lambda", 0]);
      expect(dimensions).toEqual({ FunctionName: fnName });
      // Alerting-plane requests are refused: pages alerting-page, not the ops topic (M2).
      expect(actions).toEqual(["arn:aws:sns:us-east-1:1:alerting-page"]);
      expect(errorsActions).toEqual(["arn:aws:sns:us-east-1:1:alerting-page"]);
      await settle(api);
    });

    it("pages alerting-page (and the ops topic) on every RevocationCheckFailOpen", async () => {
      const api = await buildApi("fail-open-alarm");
      api.sealRouteSettings();
      const { failOpen } = api.addAlarms(
        "arn:aws:sns:us-east-1:123456789012:chief",
        "arn:aws:sns:us-east-1:123456789012:alerting-page",
      );
      const [metric, namespace, threshold, actions] = await Promise.all([
        resolve(failOpen.metricName),
        resolve(failOpen.namespace),
        resolve(failOpen.threshold),
        resolve(failOpen.alarmActions),
      ]);
      expect(metric).toBe("RevocationCheckFailOpen");
      expect(namespace).toBe("Boxalarm/authorizer");
      expect(threshold).toBe(0);
      // A revoked session is reaching the alerting plane: pages alerting-page, and tells the
      // chief (F9).
      expect(actions).toEqual([
        "arn:aws:sns:us-east-1:123456789012:alerting-page",
        "arn:aws:sns:us-east-1:123456789012:chief",
      ]);
      await settle(api);
    });

    it("gives each reserved route its own stage throttle and leaves other routes on the default", async () => {
      const api = await buildApi("settings");
      api.authorizedRoute("dispatch", { routeKey: "POST /api/v1/alerting/dispatches" });
      api.authorizedRoute("respond", {
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/responses",
      });
      api.authorizedRoute("roster", { routeKey: "GET /api/v1/personnel/members" });
      api.sealRouteSettings();

      const settings = await resolve(api.stage.routeSettings);
      expect(settings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            routeKey: "POST /api/v1/alerting/dispatches",
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
          }),
          expect.objectContaining({
            routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/responses",
            throttlingRateLimit: 100,
            throttlingBurstLimit: 200,
          }),
        ]),
      );
      expect(settings).toHaveLength(2);
      expect(settings?.map((st) => st.routeKey)).not.toContain("GET /api/v1/personnel/members");
      await settle(api);
    });

    it("refuses to seal with requireAll when a reserved route was never registered", async () => {
      const api = await buildApi("require-all");
      api.authorizedRoute("dispatch", { routeKey: "POST /api/v1/alerting/dispatches" });

      expect(() => api.sealRouteSettings({ requireAll: true })).toThrow(
        /reserved alerting routes never registered/,
      );
      api.sealRouteSettings();
      await settle(api);
    });
  });

  it("authorizedRoute always attaches CUSTOM + this authorizer (no open routes)", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-route", {
      env: "dev",
      serviceName: "platform-service",
    });
    const api = new HttpApi("http-api-route", {
      env: "dev",
      userPoolId: "us-east-1_pool",
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: ["web-client-id"],
      platformLogGroup: logGroup,
    });
    await settle(api);

    const route = api.authorizedRoute("health-route", { routeKey: "GET /health" });
    const [authType, authorizerId, routeAuthorizerId] = await Promise.all([
      resolve(route.authorizationType),
      resolve(api.authorizer.id),
      resolve(route.authorizerId as pulumi.Output<string>),
    ]);
    expect(authType).toBe("CUSTOM");
    expect(routeAuthorizerId).toBe(authorizerId);
  });

  it("throws on absent env", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-api-bad", {
      env: "dev",
      serviceName: "platform-service",
    });

    expect(
      () =>
        new HttpApi("http-api-bad", {
          env: undefined as unknown as string,
          userPoolId: "pool",
          platformTableName: "platform-table",
          platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
          allowedClientIds: ["a"],
          platformLogGroup: logGroup,
        }),
    ).toThrow(/env is required/);
  });

  it("route() wires an AWS_PROXY integration to an authorized route for the given service Lambda", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { ServiceLambda } = await import("../../components/observability/service-lambda");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-api-route", {
      env: "dev",
      serviceName: "platform-service",
    });
    const api = new HttpApi("http-api-route", {
      env: "dev",
      userPoolId: "pool",
      platformTableName: "platform-table",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      allowedClientIds: ["a"],
      platformLogGroup: logGroup,
    });
    await settle(api);

    const lambda = new ServiceLambda("route-lambda", {
      env: "dev",
      serviceName: "platform-service",
      functionName: "boxalarm-dev-platform-config",
      handler: "index.handler",
      code: new pulumi.asset.AssetArchive({}),
      logGroup,
    });
    const { route, integration } = api.route("config-route", {
      routeKey: "GET /api/v1/platform/config",
      lambda,
    });

    const [integrationType, routeKey, authType] = await Promise.all([
      resolve(integration.integrationType),
      resolve(route.routeKey),
      resolve(route.authorizationType),
    ]);
    expect(integrationType).toBe("AWS_PROXY");
    expect(routeKey).toBe("GET /api/v1/platform/config");
    expect(authType).toBe("CUSTOM");
  });
});
