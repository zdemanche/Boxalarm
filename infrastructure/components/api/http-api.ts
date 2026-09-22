import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";

export interface HttpApiArgs {
  env: string;
  userPoolId: pulumi.Input<string>;
  /** Web + mobile Cognito app client IDs (joined as COGNITO_ALLOWED_CLIENT_IDS). */
  allowedClientIds: pulumi.Input<string>[];
  /** Shared platform-service log group (one per env). */
  platformLogGroup: ServiceLogGroup;
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
}

/**
 * Shared HTTP API + REQUEST Lambda authorizer (E8-S1-INFRA). Routes and
 * integrations are owned by later stories; this component owns the API shell,
 * default authorizer, and fail-closed stub until the backend artifact ships.
 */
export class HttpApi extends pulumi.ComponentResource {
  public readonly httpApi: aws.apigatewayv2.Api;
  public readonly authorizer: aws.apigatewayv2.Authorizer;
  public readonly authorizerLambda: ServiceLambda;
  public readonly invokePermission: aws.lambda.Permission;
  public readonly stage: aws.apigatewayv2.Stage;
  public readonly apiEndpoint: pulumi.Output<string>;

  constructor(name: string, args: HttpApiArgs, opts?: pulumi.ComponentResourceOptions) {
    if (typeof args.env !== "string" || args.env.length === 0) {
      throw new Error(`HttpApi: env is required (received ${JSON.stringify(args.env)})`);
    }

    super("boxalarm:api:HttpApi", name, {}, opts);
    const { env } = args;

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

    this.authorizerLambda = new ServiceLambda(
      `${name}-authorizer`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-authorizer`,
        handler: "authorizer-handler.handler",
        code: new pulumi.asset.AssetArchive({
          "authorizer-handler.js": new pulumi.asset.FileAsset(
            path.join(__dirname, "authorizer-handler.js"),
          ),
        }),
        logGroup: args.platformLogGroup,
        environment: {
          COGNITO_USER_POOL_ID: args.userPoolId,
          COGNITO_ISSUER: cognitoIssuer,
          COGNITO_ALLOWED_CLIENT_IDS: allowedClientIds,
        },
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
        // Fail-closed stub: never cache an allow decision (0 once real authorizer ships too).
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
      },
      { parent: this },
    );

    this.apiEndpoint = this.httpApi.apiEndpoint;

    this.registerOutputs({
      httpApi: this.httpApi,
      authorizer: this.authorizer,
      apiEndpoint: this.apiEndpoint,
      stage: this.stage,
    });
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
    return new aws.apigatewayv2.Route(
      name,
      {
        apiId: this.httpApi.id,
        routeKey: args.routeKey,
        target: args.target,
        authorizationType: "CUSTOM",
        authorizerId: this.authorizer.id,
      },
      { parent: this, ...opts },
    );
  }
}
