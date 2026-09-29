import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup, RETENTION_DAYS_BY_ENV } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { LAMBDA_HANDLER, lambdaCode } from "../shared/lambda-code";

export interface HttpApiArgs {
  env: string;
  userPoolId: pulumi.Input<string>;
  /** Web + mobile Cognito app client IDs (joined as COGNITO_ALLOWED_CLIENT_IDS). */
  allowedClientIds: pulumi.Input<string>[];
  /** Shared platform-service log group (one per env). */
  platformLogGroup: ServiceLogGroup;
  /**
   * Holds the per-member session revocation markers (DEPT#{deptId}#SESSION_REVOCATION#{sub})
   * the authorizer checks every token's iat against (review M1).
   */
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  /** Override Cognito issuer; default is https://cognito-idp.{region}.amazonaws.com/{userPoolId}. */
  cognitoIssuer?: pulumi.Input<string>;
  /**
   * Stage-level steady-state request rate limit (requests/sec). Every request hits
   * the authorizer Lambda (authorizerResultTtlInSeconds: 0, never cached) before any
   * auth check, so an unthrottled stage lets an unauthenticated flood exhaust the
   * account's shared regional Lambda concurrency pool — which alerting-service also
   * draws from. Conservative default; later stories may need to tune it.
   */
  throttlingRateLimit?: number;
  /** Stage-level burst capacity (requests). See throttlingRateLimit. */
  throttlingBurstLimit?: number;
  /**
   * Reserved concurrency for the authorizer Lambda, so an unauthenticated request
   * flood against this Lambda cannot starve concurrency the alerting path needs.
   * Conservative default; later stories may need to tune it.
   */
  authorizerReservedConcurrency?: number;
  /**
   * Reserved concurrency for the second authorizer that serves only ALERTING_PLANE_ROUTES
   * (review M4), so a flood of junk tokens on any other route cannot exhaust the
   * authorizer capacity a responder needs to see and answer a call.
   */
  alertingAuthorizerReservedConcurrency?: number;
}

export interface RouteThrottle {
  readonly rateLimit: number;
  readonly burstLimit: number;
}

/**
 * The alerting plane's authenticated routes. Each is served by the alerting authorizer, which
 * (a) has its own reserved concurrency and each route its own stage throttle bucket (review
 * M4), so a flood elsewhere cannot consume their capacity, and (b) runs with
 * REVOCATION_CHECK_FAIL_OPEN=true, so a platform-table outage can never 403 them (review of
 * fix/access-control, MAJOR 1 - backend platform-service/authorizer/revocationCheck.ts). An
 * outage in the LOB plane must never degrade alerting (backend/CLAUDE.md).
 *
 * Every route key here must be registered through authorizedRoute(); index.ts seals with
 * requireAll, so a renamed or removed route fails the deploy instead of silently moving back
 * to the LOB authorizer. The vendor receipt webhooks are not here: they use no authorizer.
 */
// Review MAJOR 3: a per-route limit is a cap as well as a reservation, so none of these may
// sit below the stage default (50 rps / 100 burst) - a lower one just lets a smaller flood
// 429 every responder. Response and read routes carry the whole roster at once (every member
// answering and then polling the roster within seconds of a tone), so they get double.
// Manual dispatch is rare, but when it is used it is the N1.8 degraded path - never starved.
const DEFAULT_ALERTING_THROTTLE: RouteThrottle = { rateLimit: 50, burstLimit: 100 };
const CALL_TRAFFIC_THROTTLE: RouteThrottle = { rateLimit: 100, burstLimit: 200 };

export const ALERTING_PLANE_ROUTES: Readonly<Record<string, RouteThrottle>> = {
  "POST /api/v1/alerting/dispatches": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/dispatches": CALL_TRAFFIC_THROTTLE,
  "GET /api/v1/alerting/dispatches/{dispatchId}": CALL_TRAFFIC_THROTTLE,
  "GET /api/v1/alerting/dispatches/{dispatchId}/roster": CALL_TRAFFIC_THROTTLE,
  "POST /api/v1/alerting/dispatches/{dispatchId}/responses": CALL_TRAFFIC_THROTTLE,
  "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/halt": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/acknowledge": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/apparatus/riding-board/{dispatchId}": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/apparatus/riding-board/{dispatchId}/assignments": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/personnel/members/{memberId}/push-tokens": DEFAULT_ALERTING_THROTTLE,
  "DELETE /api/v1/personnel/members/{memberId}/push-tokens": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/dispatches/{dispatchId}/receipts": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics/{memberId}": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/home-locality": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/audit": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/canary/status": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/delivery-baseline": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/alerting/devices/state": DEFAULT_ALERTING_THROTTLE,
  "POST /api/v1/alerting/self-test": DEFAULT_ALERTING_THROTTLE,
  "GET /api/v1/alerting/self-test/{testId}": DEFAULT_ALERTING_THROTTLE,
};

/**
 * Shared HTTP API + REQUEST Lambda authorizer (E8-S1-INFRA). Routes and
 * integrations are owned by later stories; this component owns the API shell and
 * the authorizer: the bundled backend platform-service/authorizer (Cognito
 * access-token verification), or - only when no bundle exists - the deny-all stub.
 */

/**
 * The deny-all stub, served as index.js so it uses the same handler string as the bundle.
 * Only ever deployed when backend/dist has no authorizer bundle (lambdaCode warns).
 */
function denyAllAuthorizerCode(): pulumi.asset.Archive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.FileAsset(path.join(__dirname, "authorizer-handler.js")),
  });
}
export class HttpApi extends pulumi.ComponentResource {
  public readonly httpApi: aws.apigatewayv2.Api;
  public readonly authorizer: aws.apigatewayv2.Authorizer;
  public readonly authorizerLambda: ServiceLambda;
  public readonly invokePermission: aws.lambda.Permission;
  /** M4: serves ALERTING_PLANE_ROUTES only, with its own reserved concurrency. */
  public readonly alertingAuthorizer: aws.apigatewayv2.Authorizer;
  public readonly alertingAuthorizerLambda: ServiceLambda;
  public readonly alertingInvokePermission: aws.lambda.Permission;
  /** Reserved routes registered so far, keyed by route key (see sealRouteSettings). */
  private readonly reservedRoutes = new Map<string, aws.apigatewayv2.Route>();
  private routeSettingsSealed = false;
  private readonly env: string;
  private readonly name: string;
  private resolveRouteSettings!: (
    settings: pulumi.Input<aws.types.input.apigatewayv2.StageRouteSetting>[],
  ) => void;
  public readonly stage: aws.apigatewayv2.Stage;
  public readonly accessLogGroup: aws.cloudwatch.LogGroup;
  public readonly apiEndpoint: pulumi.Output<string>;

  constructor(name: string, args: HttpApiArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("HttpApi", args.env);

    super("boxalarm:api:HttpApi", name, {}, opts);
    const { env } = args;
    this.env = env;
    this.name = name;

    this.httpApi = new aws.apigatewayv2.Api(
      `${name}-api`,
      {
        name: `boxalarm-${env}-http-api`,
        protocolType: "HTTP",
      },
      { parent: this },
    );

    const cognitoIssuer =
      args.cognitoIssuer ??
      pulumi.interpolate`https://cognito-idp.${aws.getRegionOutput({}, { parent: this }).name}.amazonaws.com/${args.userPoolId}`;
    const allowedClientIds = pulumi.all(args.allowedClientIds).apply((ids) => ids.join(","));
    const throttlingRateLimit = args.throttlingRateLimit ?? 50;
    const throttlingBurstLimit = args.throttlingBurstLimit ?? 100;
    const authorizerReservedConcurrency = args.authorizerReservedConcurrency ?? 20;
    // As large as the main authorizer's: these routes now carry call-time bursts of the whole
    // roster, and a targeted flood consumes this pool too (see the Throttles alarm).
    const alertingAuthorizerReservedConcurrency = args.alertingAuthorizerReservedConcurrency ?? 20;

    const authorizerEnvironment = {
      COGNITO_USER_POOL_ID: args.userPoolId,
      COGNITO_ISSUER: cognitoIssuer,
      COGNITO_ALLOWED_CLIENT_IDS: allowedClientIds,
      PLATFORM_TABLE_NAME: args.platformTableName,
    };
    // Revocation markers only - the authorizer reads nothing else from the table.
    const authorizerStatements = pulumi.output(args.platformTableArn).apply((tableArn) => [
      {
        Sid: "ReadSessionRevocationMarkers",
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem"],
        Resource: tableArn,
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["DEPT#*#SESSION_REVOCATION#*"],
          },
        },
      },
    ]);

    this.authorizerLambda = new ServiceLambda(
      `${name}-authorizer`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-authorizer`,
        handler: LAMBDA_HANDLER,
        // Until this was wired, the stub denied 100% of requests: every authenticated route
        // in the stack answered 403.
        code: lambdaCode("platform-service", "authorizer", denyAllAuthorizerCode),
        logGroup: args.platformLogGroup,
        environment: authorizerEnvironment,
        additionalPolicyStatements: authorizerStatements,
        // Draws from the account's shared regional concurrency pool, which
        // alerting-service Lambdas also draw from — must not be unbounded on an
        // unauthenticated, uncached (authorizerResultTtlInSeconds: 0) path.
        reservedConcurrentExecutions: authorizerReservedConcurrency,
      },
      { parent: this },
    );

    this.authorizer = new aws.apigatewayv2.Authorizer(
      `${name}-authorizer`,
      {
        apiId: this.httpApi.id,
        name: `boxalarm-${env}-http-authorizer`,
        authorizerType: "REQUEST",
        authorizerUri: this.authorizerLambda.function.invokeArn,
        authorizerPayloadFormatVersion: "2.0",
        enableSimpleResponses: true,
        identitySources: ["$request.header.Authorization"],
        // Never cache an allow decision at the gateway. On its own this does NOT make a
        // revoked session stop on the next request: access tokens are verified offline and
        // stay valid for their 1-hour life after a global sign-out. What ends them is the
        // authorizer's server-side revocation check (backend platform-service/authorizer/
        // revocationCheck.ts): tokens issued at or before the member's revokedAt are refused,
        // with the marker cached per warm instance for up to 30 s. So revocation takes effect
        // within ~30 s, not on the literal next request - and a gateway cache here would
        // stretch that by its own TTL.
        authorizerResultTtlInSeconds: 0,
      },
      { parent: this },
    );

    this.invokePermission = new aws.lambda.Permission(
      `${name}-authorizer-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: this.authorizerLambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.httpApi.executionArn}/authorizers/*`,
      },
      { parent: this },
    );

    // M4: same code and config, separate function and authorizer, so its reserved concurrency
    // is consumed only by requests to the reserved alerting routes.
    this.alertingAuthorizerLambda = new ServiceLambda(
      `${name}-alerting-authorizer`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-authorizer-alerting`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "authorizer", denyAllAuthorizerCode),
        logGroup: args.platformLogGroup,
        // Every route it serves is alerting-plane: a revocation-store outage fails open here.
        environment: { ...authorizerEnvironment, REVOCATION_CHECK_FAIL_OPEN: "true" },
        additionalPolicyStatements: authorizerStatements,
        reservedConcurrentExecutions: alertingAuthorizerReservedConcurrency,
      },
      { parent: this },
    );

    this.alertingAuthorizer = new aws.apigatewayv2.Authorizer(
      `${name}-alerting-authorizer`,
      {
        apiId: this.httpApi.id,
        name: `boxalarm-${env}-http-authorizer-alerting`,
        authorizerType: "REQUEST",
        authorizerUri: this.alertingAuthorizerLambda.function.invokeArn,
        authorizerPayloadFormatVersion: "2.0",
        enableSimpleResponses: true,
        identitySources: ["$request.header.Authorization"],
        // See the main authorizer: never cache at the gateway.
        authorizerResultTtlInSeconds: 0,
      },
      { parent: this },
    );

    this.alertingInvokePermission = new aws.lambda.Permission(
      `${name}-alerting-authorizer-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: this.alertingAuthorizerLambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.httpApi.executionArn}/authorizers/*`,
      },
      { parent: this },
    );

    // Caller activity record - status, route and authorizer error - to correlate against
    // the authorizer's own deny-reason metrics.
    this.accessLogGroup = new aws.cloudwatch.LogGroup(
      `${name}-access-logs`,
      {
        name: `/aws/apigateway/boxalarm-${env}-http-api-access`,
        retentionInDays: RETENTION_DAYS_BY_ENV[env],
      },
      { parent: this },
    );

    this.stage = new aws.apigatewayv2.Stage(
      `${name}-stage`,
      {
        apiId: this.httpApi.id,
        name: "$default",
        autoDeploy: true,
        // Every request invokes the authorizer Lambda from an unauthenticated caller
        // (no caching — authorizerResultTtlInSeconds: 0), so request volume maps 1:1
        // to Lambda invocations. Without a stage-level cap, a flood against this
        // public endpoint can drive account concurrency to the ceiling and throttle
        // alerting-service, which shares the same regional pool.
        defaultRouteSettings: {
          throttlingRateLimit,
          throttlingBurstLimit,
        },
        // M4: each reserved alerting route gets its own throttle bucket. Settings may only
        // name routes that exist, so they are filled in once the routes are registered -
        // see sealRouteSettings.
        routeSettings: pulumi.output(
          new Promise<pulumi.Input<aws.types.input.apigatewayv2.StageRouteSetting>[]>((resolve) => {
            this.resolveRouteSettings = resolve;
          }),
        ),
        accessLogSettings: {
          destinationArn: this.accessLogGroup.arn,
          format: JSON.stringify({
            requestId: "$context.requestId",
            status: "$context.status",
            routeKey: "$context.routeKey",
            integrationErrorMessage: "$context.integrationErrorMessage",
            authorizerError: "$context.authorizer.error",
          }),
        },
      },
      { parent: this, dependsOn: [this.accessLogGroup] },
    );

    this.apiEndpoint = this.httpApi.apiEndpoint;

    // Fallback so a program or test that never calls sealRouteSettings() does not leave the
    // stage waiting forever. Pulumi programs build their resources synchronously, so by the
    // time this fires every route in the program has been registered; index.ts still seals
    // explicitly, with requireAll, so a renamed reserved route fails the deploy.
    setImmediate(() => this.sealRouteSettings());

    this.registerOutputs({
      httpApi: this.httpApi,
      authorizer: this.authorizer,
      alertingAuthorizer: this.alertingAuthorizer,
      apiEndpoint: this.apiEndpoint,
      stage: this.stage,
    });
  }

  /**
   * Reusable wiring for a later INFRA child's own service Lambda: AWS_PROXY
   * integration + invoke permission + an authorizedRoute target. One call
   * replaces the integration/permission/route triple every route needs.
   */
  route(
    name: string,
    args: { routeKey: string; lambda: ServiceLambda },
    opts?: pulumi.ComponentResourceOptions,
  ): { route: aws.apigatewayv2.Route; integration: aws.apigatewayv2.Integration } {
    const integration = new aws.apigatewayv2.Integration(
      `${name}-integration`,
      {
        apiId: this.httpApi.id,
        integrationType: "AWS_PROXY",
        integrationUri: args.lambda.function.invokeArn,
        payloadFormatVersion: "2.0",
      },
      { parent: this, ...opts },
    );

    new aws.lambda.Permission(
      `${name}-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: args.lambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.httpApi.executionArn}/*/*`,
      },
      { parent: this, ...opts },
    );

    const route = this.authorizedRoute(
      `${name}-route`,
      { routeKey: args.routeKey, target: pulumi.interpolate`integrations/${integration.id}` },
      opts,
    );

    return { route, integration };
  }

  /**
   * Mandatory route factory for later INFRA children (#6): every route must attach
   * this API's REQUEST authorizer. Open (NONE) routes are not permitted here.
   */
  authorizedRoute(
    name: string,
    args: {
      routeKey: string;
      target?: pulumi.Input<string>;
    },
    opts?: pulumi.ComponentResourceOptions,
  ): aws.apigatewayv2.Route {
    const reserved = Object.prototype.hasOwnProperty.call(ALERTING_PLANE_ROUTES, args.routeKey);
    const route = new aws.apigatewayv2.Route(
      name,
      {
        apiId: this.httpApi.id,
        routeKey: args.routeKey,
        target: args.target,
        authorizationType: "CUSTOM",
        authorizerId: reserved ? this.alertingAuthorizer.id : this.authorizer.id,
      },
      { parent: this, ...opts },
    );
    if (reserved) {
      if (this.routeSettingsSealed) {
        pulumi.log.warn(
          `HttpApi: reserved route "${args.routeKey}" was registered after the stage route ` +
            "settings were sealed, so it has no reserved throttle.",
          this,
        );
      } else {
        this.reservedRoutes.set(args.routeKey, route);
      }
    }
    return route;
  }

  /**
   * Security/availability alarms on the authorizers, sent to `topicArn` (the chief topic).
   * Called from index.ts once that topic exists.
   *  - RevocationCheckFailOpen: the revocation store could not be read and an alerting-plane
   *    request was let through on the token alone. Every occurrence is worth a look: while it
   *    lasts, a revoked session still reaches the alerting plane.
   */
  addAlarms(topicArn: pulumi.Input<string>): {
    failOpen: aws.cloudwatch.MetricAlarm;
    alertingAuthorizerThrottles: aws.cloudwatch.MetricAlarm;
  } {
    const env = this.env;
    const failOpen = new aws.cloudwatch.MetricAlarm(
      `${this.name}-revocation-fail-open-alarm`,
      {
        name: `boxalarm-${env}-authorizer-revocation-check-fail-open`,
        alarmDescription:
          "The session-revocation store was unreadable and alerting-plane requests were " +
          "allowed on the token alone; revoked sessions are not being refused.",
        namespace: "Boxalarm/authorizer",
        metricName: "RevocationCheckFailOpen",
        statistic: "Sum",
        period: 60,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [topicArn],
      },
      { parent: this },
    );
    // Review MAJOR 3: the alerting authorizer is throttled only when its reserved concurrency
    // is exhausted - by a call-time burst or by a junk-token flood aimed at these routes
    // (HTTP APIs cannot take AWS WAF, so there is no per-IP limit in front of it). Either way,
    // requests on the alerting plane are being refused.
    const alertingAuthorizerThrottles = new aws.cloudwatch.MetricAlarm(
      `${this.name}-alerting-authorizer-throttles-alarm`,
      {
        name: `boxalarm-${env}-platform-authorizer-alerting-throttles`,
        alarmDescription:
          "The alerting authorizer is being throttled: alerting-plane requests are refused.",
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        dimensions: { FunctionName: this.alertingAuthorizerLambda.function.name },
        statistic: "Sum",
        period: 60,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [topicArn],
      },
      { parent: this },
    );
    return { failOpen, alertingAuthorizerThrottles };
  }

  /**
   * Fixes the stage's per-route throttles to the reserved routes registered so far. Each
   * setting reads its route's routeKey Output, so the stage update waits for the route to
   * exist (API Gateway rejects settings for an unknown route). Idempotent; the first call
   * wins. With requireAll, throws unless every ALERTING_PLANE_ROUTES key was registered -
   * a renamed route would otherwise silently lose its reserved capacity.
   */
  sealRouteSettings(options: { requireAll?: boolean } = {}): void {
    if (options.requireAll) {
      const missing = Object.keys(ALERTING_PLANE_ROUTES).filter(
        (key) => !this.reservedRoutes.has(key),
      );
      if (missing.length > 0) {
        throw new Error(
          `HttpApi: reserved alerting routes never registered: ${missing.join(", ")}`,
        );
      }
    }
    if (this.routeSettingsSealed) {
      return;
    }
    this.routeSettingsSealed = true;
    this.resolveRouteSettings(
      [...this.reservedRoutes.entries()].map(([key, route]) => ({
        routeKey: route.routeKey,
        throttlingRateLimit: ALERTING_PLANE_ROUTES[key]!.rateLimit,
        throttlingBurstLimit: ALERTING_PLANE_ROUTES[key]!.burstLimit,
      })),
    );
  }
}
