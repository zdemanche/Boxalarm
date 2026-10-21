import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
        state.policyStoreId = `${args.name}-id`;
        state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}-id`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

const ALL_GROUPS = ["MEMBER", "OFFICER", "TRAINING", "APPARATUS", "ADMIN", "CHIEF"];
const NO_ROLE_GROUP = "NOT_A_ROLE";

// Written out by hand, not derived from the *_ACTIONS lists in cedar-policies.ts: a list edited
// in the source must fail here, not move the expectation with it. Cedar unions permits, so an
// action that lands in a broader list is silently granted to that whole tier.
const TIERS = [
  {
    tier: "EVERY_ROLE",
    groups: ["MEMBER", "OFFICER", "TRAINING", "APPARATUS", "ADMIN", "CHIEF"],
    actions: [
      "ViewConfig",
      "SelfUpdateMember",
      "RecordAttendance",
      "ViewOwnAttendance",
      "MarkAvailability",
      "ViewOwnAvailability",
      "EndOwnMarkoff",
      "ViewOwnLosapTotal",
      "GetQuals",
      "ViewTranscript",
      "ViewCertifications",
      "ViewTrainingHours",
      "ViewOwnNotifications",
      "MarkNotificationRead",
      "ViewOwnNotificationPreferences",
      "UpdateOwnNotificationPreferences",
      "GetChecklist",
      "SubmitApparatusCheck",
      "AttachCheckPhoto",
      "ReportDefect",
      "ViewMaintenanceHistory",
      "LogScbaRecord",
      "ViewScbaTestingSchedules",
      "ViewTestingSchedules",
      "ListCompartmentInventory",
      "ViewAlertDetail",
      "ListActiveDispatches",
      "ViewRoster",
      "RecordResponse",
      "SelfTestAlertPath",
      "ReportDeviceState",
      "ViewOwnDiagnostics",
      "ViewOwnDeliveryHistory",
      "RegisterPushToken",
      "RevokePushToken",
      "ValidateIncidentReport",
      "ViewNerisSchema",
      "EditIncidentModule",
      "EditIncidentExposures",
      "ListEquipment",
      "ViewEquipmentAsset",
      "ListConsumables",
      "ViewPpeAssignments",
      "GetPrePlan",
      "ListInspections",
      "ScheduleInspection",
      "ConductInspection",
      "SubmitFieldCapture",
      "ViewInspectionsMap",
    ],
  },
  {
    tier: "CHIEF_ADMIN",
    groups: ["ADMIN", "CHIEF"],
    actions: [
      "UpdateConfig",
      "ExportData",
      "RunRecordsDisposal",
      "ViewRetentionConfig",
      "UpdateRetentionConfig",
      "UpdateMember",
      "RevokeSession",
      "ResetMemberCredentials",
      "ViewMemberDevices",
      "ViewAuditTrail",
      "ViewCadIngress",
      "ManageCadIngress",
      "UnlockIncidentReport",
      "SyncNerisEntity",
      "ArchiveOccupancy",
      "ArchiveHydrant",
      "RecordCutoverDecision",
      "ExportReport",
    ],
  },
  {
    tier: "OFFICER_TRAINING",
    groups: ["OFFICER", "TRAINING", "ADMIN", "CHIEF"],
    actions: [
      "RecordAttendanceOnBehalf",
      "ViewAttendanceOnBehalf",
      "UpdateQuals",
      "CreateCertification",
      "RevokeCertification",
      "ViewExpiringCertifications",
      "ViewIsoTrainingReport",
      "ViewRosterTrainingHours",
      "CreateTrainingEvent",
      "RecordTrainingAttendance",
      "ApproveShiftSwap",
      "ListPendingShiftSwaps",
      "AssignRidingPosition",
      "ViewOperationalDashboard",
      "GetLosapYearEnd",
      "ViewIsoReport",
      "ViewGrantsReport",
      "ViewResponseTimes",
      "ViewMembershipTrends",
      "ViewCutoverDecision",
    ],
  },
  {
    tier: "OFFICER",
    groups: ["OFFICER", "ADMIN", "CHIEF"],
    actions: [
      "ViewMemberAvailability",
      "EndMemberMarkoff",
      "SubmitManualDispatch",
      "GetDeliveryReceipts",
      "ViewDiagnostics",
      "ViewAlertingAuditLog",
      "ViewCanaryStatus",
      "ViewDeliveryBaseline",
      "AdvanceToneLadder",
      "HaltToneLadder",
      "TriggerMutualAid",
      "AcknowledgeMutualAid",
      "CreateIncidentReport",
      "LockIncidentReport",
      "SubmitIncidentReport",
      "ResubmitIncidentReport",
      "RetryIncidentSubmission",
      "ViewIncidentSubmission",
      "RecordExposureForOthers",
      "FileNoActivityReport",
      "ViewNerisCompliance",
      "ViewNerisEntity",
      "ListRecentDispatches",
      "RegisterEquipmentAsset",
      "AssignEquipmentAsset",
      "SetEquipmentLocation",
      "TransitionAssetLifecycle",
      "IssuePpeAssignment",
      "RestockConsumable",
      "CreateConsumable",
      "UpdatePrePlan",
      "WriteOccupancy",
      "CreateHydrant",
      "UpdateHydrant",
    ],
  },
  {
    tier: "APPARATUS_OFFICER",
    groups: ["OFFICER", "APPARATUS", "ADMIN", "CHIEF"],
    actions: [
      "UpdateServiceStatus",
      "GetComplianceReport",
      "ListOpenDefects",
      "ResolveDefect",
      "LogMaintenanceRecord",
      "LogApparatusTestRecord",
      "CreateCompartmentItem",
      "UpdateCompartmentItemQuantity",
    ],
  },
];

const EXPECTED_GROUPS = new Map(
  TIERS.flatMap(({ groups, actions }) => actions.map((action) => [action, groups] as const)),
);

describe("Cedar tier matrix", () => {
  async function deployedPolicies(): Promise<string> {
    const { PolicyStore } = await import("../../components/authz/policy-store");
    const store = new PolicyStore("test-tier-matrix", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      userPoolArn: pulumi.output("arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1"),
      allowedClientIds: [pulumi.output("web-client")],
    });
    const policies = Object.values(store).filter(
      (value): value is import("@pulumi/aws").verifiedpermissions.Policy =>
        typeof value === "object" &&
        value !== null &&
        value.constructor?.name === "Policy" &&
        "definition" in value,
    );
    const statements = await Promise.all(
      policies.map(async (policy) => (await resolve(policy.definition))?.static?.statement ?? ""),
    );
    expect(statements).toHaveLength(16);
    return statements.join("\n");
  }

  it("lists every action the schema declares, once", async () => {
    const { CEDAR_SCHEMA } = await import("../../components/authz/cedar-policies");
    const declared = Object.keys(
      (JSON.parse(CEDAR_SCHEMA) as { Boxalarm: { actions: Record<string, unknown> } }).Boxalarm
        .actions,
    );
    const listed = TIERS.flatMap((tier) => tier.actions);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...declared].sort()).toEqual([...listed].sort());
  });

  it("grants every action to exactly its tier, across all 16 deployed policies", async () => {
    const { CEDAR_SCHEMA } = await import("../../components/authz/cedar-policies");
    const { isAuthorized } =
      (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
    const staticPolicies = await deployedPolicies();
    const schema = JSON.parse(CEDAR_SCHEMA) as {
      Boxalarm: { actions: Record<string, { appliesTo: { resourceTypes: string[] } }> };
    };

    const mismatches: string[] = [];
    for (const [action, definition] of Object.entries(schema.Boxalarm.actions)) {
      const resource = { type: `Boxalarm::${definition.appliesTo.resourceTypes[0]}`, id: "r-1" };
      const allowed: string[] = [];
      for (const group of [...ALL_GROUPS, NO_ROLE_GROUP]) {
        const groupUid = { type: "Boxalarm::UserGroup", id: `pool-1|${group}` };
        const principal = { type: "Boxalarm::User", id: "pool-1|user-1" };
        const result = isAuthorized({
          principal,
          action: { type: "Boxalarm::Action", id: action },
          resource,
          context: {},
          schema: schema as never,
          policies: { staticPolicies },
          entities: [
            { uid: principal, attrs: {}, parents: [groupUid] },
            { uid: groupUid, attrs: {}, parents: [] },
            { uid: resource, attrs: {}, parents: [] },
          ],
          validateRequest: true,
        });
        expect(result.type, `${action} ${group}`).toBe("success");
        if (result.type === "success" && result.response.decision === "allow") {
          allowed.push(group);
        }
      }
      const expected = EXPECTED_GROUPS.get(action) ?? [];
      if (
        allowed.join() !==
        [...expected].sort((a, b) => ALL_GROUPS.indexOf(a) - ALL_GROUPS.indexOf(b)).join()
      ) {
        mismatches.push(`${action}: allowed for [${allowed}], expected [${expected}]`);
      }
    }
    expect(mismatches).toEqual([]);
    // Every action x every group through the Cedar WASM evaluator: ~3 s alone, past vitest's 5 s
    // default when the whole suite runs in parallel.
  }, 30_000);

  it("keeps the tier action lists pairwise disjoint (reporting is the one list that spans tiers by design)", async () => {
    const policies = await import("../../components/authz/cedar-policies");
    const lists: Record<string, readonly string[]> = {
      ADMIN_ONLY_ACTIONS: policies.ADMIN_ONLY_ACTIONS,
      VIEW_ACTIONS: policies.VIEW_ACTIONS,
      SELF_SERVICE_ACTIONS: policies.SELF_SERVICE_ACTIONS,
      OFFICER_TIER_ACTIONS: policies.OFFICER_TIER_ACTIONS,
      APPARATUS_MEMBER_ACTIONS: policies.APPARATUS_MEMBER_ACTIONS,
      APPARATUS_OFFICER_ACTIONS: policies.APPARATUS_OFFICER_ACTIONS,
      INVENTORY_READ_ACTIONS: policies.INVENTORY_READ_ACTIONS,
      INVENTORY_ADMIN_ACTIONS: policies.INVENTORY_ADMIN_ACTIONS,
      ALERTING_MEMBER_ACTIONS: policies.ALERTING_MEMBER_ACTIONS,
      ALERTING_OFFICER_ACTIONS: policies.ALERTING_OFFICER_ACTIONS,
      INSPECTIONS_MEMBER_ACTIONS: policies.INSPECTIONS_MEMBER_ACTIONS,
      INSPECTIONS_OFFICER_ACTIONS: policies.INSPECTIONS_OFFICER_ACTIONS,
      AVAILABILITY_OFFICER_ACTIONS: policies.AVAILABILITY_OFFICER_ACTIONS,
      NERIS_MEMBER_ACTIONS: policies.NERIS_MEMBER_ACTIONS,
      NERIS_OFFICER_ACTIONS: policies.NERIS_OFFICER_ACTIONS,
      NERIS_ADMIN_ACTIONS: policies.NERIS_ADMIN_ACTIONS,
    };
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [listName, actions] of Object.entries(lists)) {
      for (const action of actions) {
        const first = owner.get(action);
        if (first) duplicates.push(`${action} is in both ${first} and ${listName}`);
        owner.set(action, listName);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
