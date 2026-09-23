export const ROLE_GROUPS = [
  "MEMBER",
  "OFFICER",
  "TRAINING",
  "APPARATUS",
  "ADMIN",
  "CHIEF",
] as const;
export type RoleGroup = (typeof ROLE_GROUPS)[number];

export const ADMIN_ONLY_ACTIONS = ["UpdateConfig", "ExportData", "DisposeRecords"] as const;
export const ADMIN_ONLY_GROUPS = ["CHIEF", "ADMIN"] as const;

export const CEDAR_SCHEMA = JSON.stringify({
  Boxalarm: {
    entityTypes: {
      User: {
        shape: { type: "Record", attributes: { deptId: { type: "String" } } },
        memberOfTypes: ["UserGroup"],
      },
      UserGroup: {},
      Resource: {
        shape: { type: "Record", attributes: { deptId: { type: "String" } } },
      },
    },
    actions: {
      ViewConfig: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Resource"] } },
      UpdateConfig: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Resource"] } },
      ExportData: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Resource"] } },
      DisposeRecords: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Resource"] } },
    },
  },
});

/** AC1: PUT /platform/config → UpdateConfig; only CHIEF/ADMIN, department-scoped. */
export function adminActionsPolicy(): string {
  const groups = ADMIN_ONLY_GROUPS.map((g) => `Boxalarm::UserGroup::"${g}"`).join(", ");
  const actions = ADMIN_ONLY_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal in [${groups}],\n  action in [${actions}],\n  resource\n) when { principal.deptId == resource.deptId };`;
}

/** Read access for every role, still department-scoped (N5.3). */
export function viewConfigPolicy(): string {
  const groups = ROLE_GROUPS.map((g) => `Boxalarm::UserGroup::"${g}"`).join(", ");
  return `permit (\n  principal in [${groups}],\n  action == Boxalarm::Action::"ViewConfig",\n  resource\n) when { principal.deptId == resource.deptId };`;
}
