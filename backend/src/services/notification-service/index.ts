/**
 * notification-service consumer for apparatus.defect.reported (F4.3 / E4-S4).
 *
 * Routes to the apparatus-officer role on a **non-critical** channel only
 * (in-app / push preference / digest) — never the alerting plane, never Critical Alerts.
 *
 * TODO: E3-S3 — implement once notification-service has preference + delivery patterns.
 * Until then this stub exists so EventBridge wiring has a documented LOB sink and so
 * agents do not invent alerting-plane coupling for defect fan-out.
 */
export const service = { name: 'notification-service', plane: 'lob' } as const;

export interface ApparatusDefectReportedPayload {
  readonly defectId: string;
  readonly apparatusId: string;
  readonly unitLabel: string;
  readonly reportedByMemberId: string;
  readonly severity: string;
  readonly photoS3Key?: string;
  readonly outOfService: boolean;
  readonly deptId: string;
}

export function handleApparatusDefectReported(
  payload: ApparatusDefectReportedPayload,
  correlationId: string,
): void {
  // TODO: E3-S3 — look up apparatus-officer recipients and enqueue a non-critical notification.
  console.log(
    JSON.stringify({
      event: 'notification.apparatus_defect_reported.stub',
      service: 'notification-service',
      correlationId,
      defectId: payload.defectId,
      apparatusId: payload.apparatusId,
      deptId: payload.deptId,
      severity: payload.severity,
      channelClass: 'non-critical',
      message:
        'Stub only — must use notification-service non-critical channel; do not route via the alerting plane',
    }),
  );
}

export interface ApparatusTestDuePayload {
  readonly apparatusId: string;
  readonly testType: string;
  readonly dueDate: string;
}

export function handleApparatusTestDue(
  payload: ApparatusTestDuePayload,
  correlationId: string,
): void {
  // TODO: E3-S3 — resolve the department-configured responsible role and digest-batch this per member per day.
  console.log(
    JSON.stringify({
      event: 'notification.apparatus_test_due.stub',
      service: 'notification-service',
      correlationId,
      apparatusId: payload.apparatusId,
      testType: payload.testType,
      dueDate: payload.dueDate,
      channelClass: 'non-critical',
      message:
        'Stub only — must use notification-service non-critical channel; do not route via alerting-service',
    }),
  );
}

export interface InventoryReorderDuePayload {
  readonly itemId: string;
  readonly itemName: string;
  readonly currentQty: number;
  readonly reorderThreshold: number;
  readonly deptId: string;
}

export function handleInventoryReorderDue(
  payload: InventoryReorderDuePayload,
  correlationId: string,
): void {
  // TODO: E3-S3 — look up quartermaster/admin recipients and enqueue a non-critical notification.
  console.log(
    JSON.stringify({
      event: 'notification.inventory_reorder_due.stub',
      service: 'notification-service',
      correlationId,
      itemId: payload.itemId,
      itemName: payload.itemName,
      currentQty: payload.currentQty,
      reorderThreshold: payload.reorderThreshold,
      deptId: payload.deptId,
      channelClass: 'non-critical',
      message:
        'Stub only — must use notification-service non-critical channel; do not route via the alerting plane',
    }),
  );
}
