import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
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
  /** Member rows: the status consumer acts on the row's current status, not the event's. */
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  /** Every credential reset notifies the chief, like every export. */
  chiefNotificationTopicArn: pulumi.Input<string>;
}

/** IAM for a Lambda calling cognitoRevocationClient.ts's admin APIs, scoped to one pool. */
function cognitoRevocationStatements(
  userPoolArn: pulumi.Input<string>,
  actions: readonly string[],
): pulumi.Output<IamPolicyStatement[]> {
  return pulumi.output(userPoolArn).apply((arn) => [
    {
      Sid: "RevokeAndInspectSessions",
      Effect: "Allow" as const,
      Action: [...actions],
      Resource: arn,
    },
  ]);
}

const SIGN_OUT_ACTIONS = ["cognito-idp:AdminUserGlobalSignOut", "cognito-idp:AdminGetUser"];

/**
 * M1: every revocation path writes DEPT#{deptId}#SESSION_REVOCATION#{sub}, which the
 * authorizer checks each token's iat against. Put on those keys only.
 */
function revocationMarkerStatement(tableArn: string): IamPolicyStatement {
  return {
    Sid: "WriteSessionRevocationMarker",
    Effect: "Allow",
    Action: ["dynamodb:PutItem"],
    Resource: tableArn,
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#SESSION_REVOCATION#*"] },
    },
  };
}

/**
 * E8-S8-INFRA #259 revocation resources: member-status-revocation-queue
 * consumer off the platform bus, and the admin device-loss route. Session
 * validity (1h/1h/3650d + rotation) is set on the app clients in index.ts.
 */
export class SessionRevocation extends pulumi.ComponentResource {
  public readonly memberStatusLambda: ServiceLambda;
  public readonly deviceLossLambda: ServiceLambda;
  public readonly credentialResetLambda: ServiceLambda;
  public readonly credentialResetInvokedAlarm: aws.cloudwatch.MetricAlarm;

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
        environment: {
          COGNITO_USER_POOL_ID: args.userPoolId,
          PLATFORM_TABLE_NAME: args.platformTableName,
        },
        // C1: LOA/RETIRED disables the login (sign-out alone let the same password back in);
        // a return to ACTIVE enables it again. GetItem reads the member row's current status.
        additionalPolicyStatements: pulumi
          .all([
            cognitoRevocationStatements(args.userPoolArn, [
              ...SIGN_OUT_ACTIONS,
              "cognito-idp:AdminDisableUser",
              "cognito-idp:AdminEnableUser",
            ]),
            pulumi.output(args.platformTableArn),
          ])
          .apply(([cognito, tableArn]) => [
            ...cognito,
            {
              Sid: "ReadMemberStatus",
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem"],
              Resource: tableArn,
              Condition: {
                "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#MEMBER#*"] },
              },
            },
            revocationMarkerStatement(tableArn),
          ]),
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
          PLATFORM_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([
            cognitoRevocationStatements(args.userPoolArn, SIGN_OUT_ACTIONS),
            pulumi.output(args.policyStoreArn),
            pulumi.output(args.platformTableArn),
          ])
          .apply(([revocation, policyStoreArn, tableArn]) => [
            ...revocation,
            verifiedPermissionsPolicyStatement(policyStoreArn),
            revocationMarkerStatement(tableArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-device-loss-route`,
      { routeKey: "POST /api/v1/platform/sessions/revoke", lambda: this.deviceLossLambda },
      { parent: this },
    );

    // C1: the compromised-password kill switch. Cedar ResetMemberCredentials (CHIEF/ADMIN).
    this.credentialResetLambda = new ServiceLambda(
      `${name}-credential-reset`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-credential-reset`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "session-revocation-credential-reset"),
        logGroup: args.platformLogGroup,
        environment: {
          COGNITO_USER_POOL_ID: args.userPoolId,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
          PLATFORM_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([
            cognitoRevocationStatements(args.userPoolArn, [
              ...SIGN_OUT_ACTIONS,
              "cognito-idp:AdminResetUserPassword",
            ]),
            pulumi.output(args.policyStoreArn),
            pulumi.output(args.platformTableArn),
          ])
          .apply(([revocation, policyStoreArn, tableArn]) => [
            ...revocation,
            verifiedPermissionsPolicyStatement(policyStoreArn),
            revocationMarkerStatement(tableArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-credential-reset-route`,
      {
        routeKey: "POST /api/v1/platform/sessions/reset-credentials",
        lambda: this.credentialResetLambda,
      },
      { parent: this },
    );

    // withAuthorization's alarmOnInvocation counter (Boxalarm/authz) - no threshold: an admin
    // session is one password with no second factor, so every reset is worth a look.
    this.credentialResetInvokedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-credential-reset-invoked-alarm`,
      {
        name: `boxalarm-${env}-platform-credential-reset-invoked`,
        namespace: "Boxalarm/authz",
        metricName: "ResetMemberCredentialsInvoked",
        statistic: "Sum",
        period: 60,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [args.chiefNotificationTopicArn],
      },
      { parent: this },
    );

    this.registerOutputs({
      memberStatusLambda: this.memberStatusLambda,
      deviceLossLambda: this.deviceLossLambda,
      credentialResetLambda: this.credentialResetLambda,
    });
  }
}
