import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface MembersArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  userPoolId: pulumi.Input<string>;
  userPoolArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
  /** Every LOA/RETIRED change notifies the chief (review M5). */
  chiefNotificationTopicArn: pulumi.Input<string>;
  /**
   * Verified SES sender (stack config notificationSesFromAddress): an email change is
   * notified to the member's previous address (server-fix security MAJOR 1).
   */
  sesFromAddress: pulumi.Input<string>;
}

// Per-route IAM, scoped to what each real handler (backend/src/services/personnel-service/
// members/*.ts) actually calls — not a shared read+write grant across all four routes.
// dynamodb:TransactWriteItems is not a real IAM action (DynamoDB authorizes each item in a
// transaction as its own PutItem/UpdateItem/DeleteItem call), so it was granting nothing;
// dropped everywhere below rather than carried forward as dead weight.

/** list.ts: Query on GSI3 only — read-only route, no write action of any kind. */
const LIST_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersListAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:Query"],
      Resource: [`${arn}/index/GSI3`],
    },
  ]);

/** get.ts: GetItem only — read-only route, no write action of any kind. */
const GET_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersGetAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem"],
      Resource: [arn],
    },
  ]);

/**
 * create.ts: PutItem for the new MEMBER row, its AUDIT_LOG_ENTRY and the
 * personnel.member.updated OUTBOX_ENTRY that seeds the alerting snapshot's phone contacts
 * (one TransactWriteCommand of three Puts).
 */
const CREATE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersCreateAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/**
 * create.ts also creates the member's login (lib/memberLogin.ts): AdminCreateUser, then
 * AdminAddUserToGroup MEMBER, and AdminDeleteUser to undo a login whose member row could
 * not be written. Scoped to this env's pool only.
 */
const CREATE_LOGIN_STATEMENT = (userPoolArn: pulumi.Input<string>) =>
  pulumi.output(userPoolArn).apply((arn) => [
    {
      Sid: "MembersCreateLogin" as const,
      Effect: "Allow" as const,
      Action: [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminDeleteUser",
      ],
      Resource: [arn],
    },
  ]);

/**
 * updateStatus.ts: GetItem (reads the member before validating the transition),
 * UpdateItem (the member row), PutItem (the AUDIT_LOG_ENTRY row and the OUTBOX_ENTRY
 * row, both in the same transaction — memberRepository.ts's updateMemberStatus).
 */
const UPDATE_STATUS_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersUpdateStatusAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/**
 * updateRoles.ts: GetItem (reads the member's current roles, dept-scoped), then one
 * transaction of UpdateItem (the member row's roles) + PutItem (AUDIT_LOG_ENTRY and the
 * personnel.member.updated OUTBOX_ENTRY). No Query, no DeleteItem.
 */
const UPDATE_ROLES_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersUpdateRolesAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/**
 * updateRoles.ts also syncs the member's Cognito role groups (lib/memberLogin.ts
 * syncRoleGroups): list, then add/remove the difference. It never creates or deletes a
 * login, so it holds neither of those. Scoped to this env's pool only.
 */
const UPDATE_ROLES_GROUPS_STATEMENT = (userPoolArn: pulumi.Input<string>) =>
  pulumi.output(userPoolArn).apply((arn) => [
    {
      Sid: "MembersUpdateRoleGroups" as const,
      Effect: "Allow" as const,
      Action: [
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
      ],
      Resource: [arn],
    },
  ]);

/**
 * E2-S1-INFRA #203 roster routes: create/list/get/updateStatus, each its own
 * Lambda bundled from backend/src/services/personnel-service/members via
 * lambda-code.ts, scoped to the platform-service table + policy store.
 */
export class Members extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly listLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly updateStatusLambda: ServiceLambda;
  public readonly updateProfileLambda: ServiceLambda;
  public readonly updateRolesLambda: ServiceLambda;
  /** Keyed by the status that alarms: LOA, RETIRED. */
  public readonly deactivationAlarms: Record<"LOA" | "RETIRED", aws.cloudwatch.MetricAlarm>;
  /** Security-web MAJOR 2: a member's recovery address moved, or Cognito and the row diverged. */
  public readonly emailAlarms: Record<
    "MemberEmailChanged" | "MemberEmailCompensationFailed" | "MemberEmailSignOutFailed",
    aws.cloudwatch.MetricAlarm
  >;

  constructor(name: string, args: MembersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Members", args.env);
    super("boxalarm:personnel:Members", name, {}, opts);
    const { env } = args;

    // Every members Lambda is granted verifiedpermissions:IsAuthorizedWithToken (below)
    // but without this env var, readAuthzConfig() throws on every withAuthorization()
    // call — the IAM grant alone is not enough for @boxalarm/authz's client to work.
    const baseEnvironment = {
      PERSONNEL_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-create"),
        logGroup: args.logGroup,
        environment: { ...baseEnvironment, COGNITO_USER_POOL_ID: args.userPoolId },
        additionalPolicyStatements: pulumi
          .all([
            CREATE_STATEMENT(args.platformTableArn),
            CREATE_LOGIN_STATEMENT(args.userPoolArn),
            vpStatement,
          ])
          .apply(([table, login, vp]) => [...table, ...login, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      { routeKey: "POST /api/v1/personnel/members", lambda: this.createLambda },
      { parent: this },
    );

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-list`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-list"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([LIST_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      { routeKey: "GET /api/v1/personnel/members", lambda: this.listLambda },
      { parent: this },
    );

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-get"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([GET_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/personnel/members/{memberId}", lambda: this.getLambda },
      { parent: this },
    );

    this.updateStatusLambda = new ServiceLambda(
      `${name}-update-status`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-update-status`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-update-status"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        // No personnel role holds any permission on the alerting-service or
        // incident-service tables (issue AC4) — statements below are scoped to
        // the platform table alone, plus the audit-key mutation deny (which now
        // allows the PutItem this route's own audit write needs — see
        // auditMutationDenyStatement's doc comment in data/platform-table.ts).
        additionalPolicyStatements: pulumi
          .all([UPDATE_STATUS_STATEMENT(args.platformTableArn), vpStatement, args.platformTableArn])
          .apply(([table, vp, tableArn]) => [
            ...table,
            ...vp,
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-status-route`,
      {
        routeKey: "PUT /api/v1/personnel/members/{memberId}/status",
        lambda: this.updateStatusLambda,
      },
      { parent: this },
    );

    // Review M5: LOA/RETIRED ends the member's sessions and removes them from paging. With a
    // single-factor officer password able to do that, every such change reaches the chief -
    // no threshold, like export. The handler's MemberStatusUpdated EMF carries NewStatus.
    const deactivationAlarm = (status: "LOA" | "RETIRED") =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-status-${status.toLowerCase()}-alarm`,
        {
          name: `boxalarm-${env}-personnel-member-set-${status.toLowerCase()}`,
          alarmDescription: `A member was set to ${status}: their sessions end and they stop being paged.`,
          namespace: "Boxalarm/personnel",
          metricName: "MemberStatusUpdated",
          dimensions: { NewStatus: status },
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
    this.deactivationAlarms = {
      LOA: deactivationAlarm("LOA"),
      RETIRED: deactivationAlarm("RETIRED"),
    };

    // Security-web MAJOR 2: a chief/admin email edit moves where "Reset password" sends its
    // code (updateMember.ts syncs it to Cognito). The chief hears of every one, as for LOA -
    // and of a row write whose Cognito change could not be undone (the two now differ).
    const emailAlarm = (
      metricName:
        "MemberEmailChanged" | "MemberEmailCompensationFailed" | "MemberEmailSignOutFailed",
      slug: string,
      alarmDescription: string,
    ) =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${slug}-alarm`,
        {
          name: `boxalarm-${env}-personnel-${slug}`,
          alarmDescription,
          namespace: "Boxalarm/personnel",
          metricName,
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
    this.emailAlarms = {
      MemberEmailChanged: emailAlarm(
        "MemberEmailChanged",
        "member-email-changed",
        "A member's email - their password-recovery address - was changed by a chief or admin (personnel.member.email.changed names who).",
      ),
      MemberEmailCompensationFailed: emailAlarm(
        "MemberEmailCompensationFailed",
        "member-email-diverged",
        "A member's email change reached Cognito but not the member row, and could not be undone: their recovery code goes to an address the console does not show. " +
          "Re-save the email from the member's page (personnel.member.email.compensationFailed names the member).",
      ),
      MemberEmailSignOutFailed: emailAlarm(
        "MemberEmailSignOutFailed",
        "member-email-signout-failed",
        "A member's login email changed but their sessions could not be ended (personnel.member.email.signOutFailed names the member). " +
          "Use Account security > Report device lost for them (all devices) so no session from before the change survives.",
      ),
    };

    // E2-S6-INFRA #208: member self-service profile/contact update (F2.6, AP 12). One route,
    // two Cedar actions: updateMember.ts authorizes SelfUpdateMember (every role, via the
    // self-service policy) when the path memberId is the caller's own sub — and re-checks
    // memberId === principal.sub before writing — and UpdateMember (ADMIN_ONLY_ACTIONS,
    // CHIEF/ADMIN) for anyone else's profile.
    this.updateProfileLambda = new ServiceLambda(
      `${name}-update-profile`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-update-profile`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-update-profile"),
        logGroup: args.logGroup,
        // updateMember.ts reads PLATFORM_TABLE_NAME (config.ts readMemberServiceConfig),
        // not PERSONNEL_TABLE_NAME like the other members routes. COGNITO_USER_POOL_ID: an
        // email change is written to the member's login too (lib/memberLogin.ts).
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
          COGNITO_USER_POOL_ID: args.userPoolId,
          NOTIFICATION_SES_FROM_ADDRESS: args.sesFromAddress,
        },
        // A login-email change also ends the member's sessions (the revocation marker is a
        // PutItem the table-wide grant below already covers; AdminUserGlobalSignOut) and
        // emails the previous address (ses:SendEmail on the sending identity only).
        // UpdateItem (member row) + PutItem (outbox row), one transaction; plus the
        // audit-key mutation deny every table-wide UpdateItem holder carries (F9.4).
        // GetItem on member rows only: an email edit reads the stored address first.
        // AdminUpdateUserAttributes in this pool only: the email sync and its undo.
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            vpStatement,
            args.userPoolArn,
            args.sesFromAddress,
            aws.getRegionOutput({}, { parent: this }).name,
            aws.getCallerIdentityOutput({}, { parent: this }).accountId,
          ])
          .apply(([tableArn, vp, userPoolArn, fromAddress, regionName, accountId]) => [
            {
              Sid: "MembersUpdateProfileAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem", "dynamodb:PutItem"],
              Resource: [tableArn],
            },
            {
              Sid: "MembersUpdateProfileReadMember" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem"],
              Resource: [tableArn],
              Condition: {
                "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#MEMBER#*"] },
              },
            },
            {
              Sid: "MembersUpdateProfileLoginEmail" as const,
              Effect: "Allow" as const,
              Action: [
                "cognito-idp:AdminUpdateUserAttributes",
                "cognito-idp:AdminUserGlobalSignOut",
              ],
              Resource: [userPoolArn],
            },
            {
              // SES authorizes SendEmail against the sending identity: the address itself,
              // or its domain when the domain is the verified identity.
              Sid: "MembersUpdateProfileEmailNotice" as const,
              Effect: "Allow" as const,
              Action: ["ses:SendEmail"],
              Resource: [
                `arn:aws:ses:${regionName}:${accountId}:identity/${fromAddress}`,
                `arn:aws:ses:${regionName}:${accountId}:identity/${fromAddress.split("@")[1] ?? fromAddress}`,
              ],
            },
            ...vp,
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-profile-route`,
      { routeKey: "PUT /api/v1/personnel/members/{memberId}", lambda: this.updateProfileLambda },
      { parent: this },
    );

    // F2.7 role assignment. updateRoles.ts gates on the authorizer's cognito:groups
    // (CHIEF/ADMIN, never the caller's own roles) and makes no Verified Permissions call,
    // so this Lambda holds no IsAuthorizedWithToken grant and no policy-store env.
    this.updateRolesLambda = new ServiceLambda(
      `${name}-update-roles`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-update-roles`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-update-roles"),
        logGroup: args.logGroup,
        environment: {
          PERSONNEL_TABLE_NAME: args.platformTableName,
          COGNITO_USER_POOL_ID: args.userPoolId,
        },
        additionalPolicyStatements: pulumi
          .all([
            UPDATE_ROLES_STATEMENT(args.platformTableArn),
            UPDATE_ROLES_GROUPS_STATEMENT(args.userPoolArn),
            args.platformTableArn,
          ])
          .apply(([table, groups, tableArn]) => [
            ...table,
            ...groups,
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-roles-route`,
      {
        routeKey: "PUT /api/v1/personnel/members/{memberId}/roles",
        lambda: this.updateRolesLambda,
      },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      getLambda: this.getLambda,
      updateStatusLambda: this.updateStatusLambda,
      updateProfileLambda: this.updateProfileLambda,
      updateRolesLambda: this.updateRolesLambda,
    });
  }
}
