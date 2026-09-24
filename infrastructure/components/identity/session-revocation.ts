import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { PlatformBus } from "../messaging/platform-bus";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { IamPolicyStatement } from "../observability/observability-policy";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface SessionRevocationArgs {
  env: string;
  userPoolId: pulumi.Input<string>;
  userPoolArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  platformLogGroup: ServiceLogGroup;
  httpApi: HttpApi;
  platformBus: PlatformBus;
}

/** IAM for a Lambda calling cognitoRevocationClient.ts's two admin APIs, scoped to one pool. */
function cognitoRevocationStatements(
  userPoolArn: pulumi.Input<string>,
): pulumi.Output<IamPolicyStatement[]> {
  return pulumi.output(userPoolArn).apply((arn) => [
    {
      Sid: "RevokeAndInspectSessions",
      Effect: "Allow" as const,
      Action: ["cognito-idp:AdminUserGlobalSignOut", "cognito-idp:AdminGetUser"],
      Resource: arn,
    },
  ]);
}

/**
 * E8-S8-INFRA #259 revocation resources: member-status-revocation-queue
 * consumer off the platform bus, and the admin device-loss route. Session
 * validity (1h/1h/3650d + rotation) is set on the app clients in index.ts.
 */
export class SessionRevocation extends pulumi.ComponentResource {
  public readonly memberStatusLambda: ServiceLambda;
  public readonly deviceLossLambda: ServiceLambda;

  constructor(name: string, args: SessionRevocationArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("SessionRevocation", args.env);
    super("boxalarm:identity:SessionRevocation", name, {}, opts);
    const { env } = args;

    this.memberStatusLambda = new ServiceLambda(
      `${name}-member-status`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-member-status-revocation`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "session-revocation-member-status"),
        logGroup: args.platformLogGroup,
        environment: { COGNITO_USER_POOL_ID: args.userPoolId },
        additionalPolicyStatements: cognitoRevocationStatements(args.userPoolArn),
      },
      { parent: this },
    );

    args.platformBus.addQueueConsumer(
      `${name}-member-status-consumer`,
      {
        env,
        ruleName: `boxalarm-${env}-member-status-revocation`,
        eventPattern: JSON.stringify({ "detail-type": ["personnel.member.updated"] }),
        queueName: `boxalarm-${env}-member-status-revocation-queue`,
        lambda: this.memberStatusLambda.function,
        lambdaRole: this.memberStatusLambda.role,
        maxReceiveCount: 5,
      },
      { parent: this },
    );

    this.deviceLossLambda = new ServiceLambda(
      `${name}-device-loss`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-device-loss-revocation`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "session-revocation-device-loss"),
        logGroup: args.platformLogGroup,
        environment: {
          COGNITO_USER_POOL_ID: args.userPoolId,
          // Granted verifiedpermissions:IsAuthorizedWithToken below — without this,
          // readAuthzConfig() throws on every withAuthorization() call.
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([cognitoRevocationStatements(args.userPoolArn), pulumi.output(args.policyStoreArn)])
          .apply(([revocation, policyStoreArn]) => [
            ...revocation,
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-device-loss-route`,
      { routeKey: "POST /api/v1/platform/sessions/revoke", lambda: this.deviceLossLambda },
      { parent: this },
    );

    this.registerOutputs({
      memberStatusLambda: this.memberStatusLambda,
      deviceLossLambda: this.deviceLossLambda,
    });
  }
}
