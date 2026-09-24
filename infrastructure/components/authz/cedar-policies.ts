export const ROLE_GROUPS = [
  "MEMBER",
  "OFFICER",
  "TRAINING",
  "APPARATUS",
  "ADMIN",
  "CHIEF",
] as const;
export type RoleGroup = (typeof ROLE_GROUPS)[number];

// Action IDs are pinned to what @boxalarm/authz's withAuthorization callers actually
// send (grep backend/packages/authz + the withAuthorization call sites), not aspirational
// names — a mismatch here means Verified Permissions can never match a policy for that
// action and the request falls through to the implicit DENY.
//
// RunRecordsDisposal / ViewRetentionConfig / UpdateRetentionConfig / UpdateMember are
// live today (retention/disposalHandler.ts, retention/configHandler.ts,
// members/updateMember.ts). ViewConfig / UpdateConfig / ExportData are not yet called —
// config/handler.ts and export/authz.ts still gate on assertChiefOrAdmin, with a TODO to
// swap to Cedar once this policy store ships — defined ahead of that swap so it isn't a
// companion infra change later. RevokeSession is the same: deviceLossHandler.ts still
// gates on a manual ADMIN_GROUPS check (TODO: E8-S3), defined ahead of time per the
// audit finding that this schema doesn't yet cover session-revocation actions.
export const ADMIN_ONLY_ACTIONS = [
  "UpdateConfig",
  "ExportData",
  "RunRecordsDisposal",
  "ViewRetentionConfig",
  "UpdateRetentionConfig",
  "UpdateMember",
  "RevokeSession",
] as const;
export const ADMIN_ONLY_GROUPS = ["CHIEF", "ADMIN"] as const;

export const VIEW_ACTIONS = ["ViewConfig"] as const;

// Department-scoping is NOT expressed here as a `when` clause comparing
// principal/resource attributes. Two things rule that out for every action above:
//   1. @boxalarm/authz's isAuthorized() calls IsAuthorizedWithTokenCommand with the
//      caller's ACCESS token. Per the Verified Permissions docs, access-token claims
//      map to the request's `context`, never to principal entity attributes — only ID
//      tokens populate principal attributes. custom:deptId (the actual claim name) would
//      need to be read via context, not principal.deptId.
//   2. decide.ts's isAuthorized() passes only { entityType, entityId } for the resource,
//      with no `entities` — so a resource attribute (e.g. resource.deptId) is never
//      populated and any `when` clause referencing it evaluates to an error, which Cedar
//      treats as an implicit DENY. This is a structural fact of how the call is built,
//      not a schema problem this policy store can fix on its own.
// Every action above already targets "my own department's resource" — every
// resourceId(event) call site in the backend passes the caller's own verified deptId
// (or a member scoped to it), so a same-department check would be tautological even if
// it could be expressed. CLAUDE.md states the actual design point plainly: "Export and
// destructive actions are gated by Cedar role check alone." Department isolation is
// enforced where CLAUDE.md says it lives — dept-scoped DynamoDB keys built from the
// verified JWT (buildDeptScopedPk) — not duplicated here.
export const CEDAR_SCHEMA = JSON.stringify({
  Boxalarm: {
    entityTypes: {
      User: { memberOfTypes: ["UserGroup"] },
      UserGroup: {},
      // Resource types actually sent as resourceType by withAuthorization callers.
      Department: {},
      Member: {},
    },
    actions: {
      ViewConfig: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] } },
      UpdateConfig: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] } },
      ExportData: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] } },
      RunRecordsDisposal: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      ViewRetentionConfig: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      UpdateRetentionConfig: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      UpdateMember: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      RevokeSession: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
    },
  },
});

// Cedar's scope clause only accepts an entity LIST for the `action` element — `principal
// in [group1, group2, ...]` is not valid Cedar grammar (only `principal in <single
// entity>` is), so the group check has to move into a `when` clause as an OR of
// individual `in` membership tests. The original `principal in [group1, group2]` form
// here would have failed to parse at CreatePolicy time, not merely evaluated to DENY.

// Verified Permissions Cognito identity sources scope group entity IDs to the pool
// they came from — "<userPoolId>|<groupName>", never the bare group name — since
// Cognito groups are only unique within their own user pool. A policy referencing
// Boxalarm::UserGroup::"CHIEF" literally can never match and every action gated by
// it silently falls through to the implicit DENY. See AWS docs:
// https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources-cognito.md
function groupEntityId(userPoolId: string, groupName: string): string {
  return `${userPoolId}|${groupName}`;
}

/** AC1: admin-only actions (config writes, export, disposal, member/session admin) — CHIEF/ADMIN only. */
export function adminActionsPolicy(userPoolId: string): string {
  const groupCheck = ADMIN_ONLY_GROUPS.map(
    (g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`,
  ).join(" || ");
  const actions = ADMIN_ONLY_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actions}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}

/** Read access for every role (N5.3). */
export function viewConfigPolicy(userPoolId: string): string {
  const groupCheck = ROLE_GROUPS.map(
    (g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`,
  ).join(" || ");
  const actions = VIEW_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actions}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}
