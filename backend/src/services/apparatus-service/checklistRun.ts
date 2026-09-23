import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { ValidationFieldError } from './problemDetails.js';

export interface ItemResult {
  readonly code: string;
  readonly pass: boolean;
  readonly note: string | null;
}

export interface SubmitCheckInput {
  readonly templateId: string;
  readonly completedBy: string;
  readonly completedAt: number;
  readonly durationSeconds: number;
  readonly itemResults: readonly ItemResult[];
  readonly idempotencyKey: string;
  readonly capturedOffline: boolean;
}

export interface ChecklistRun {
  readonly apparatusId: string;
  readonly deptId: string;
  readonly templateId: string;
  readonly completedBy: string;
  readonly completedAt: number;
  readonly durationSeconds: number;
  readonly itemResults: readonly ItemResult[];
  readonly defectIds: readonly string[];
  readonly capturedOffline: boolean;
  readonly syncedAt: number | null;
}

export type ChecklistRunItem = Record<string, unknown>;

const CHECK_SK_PREFIX = 'CHECK#';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateItemResult(raw: unknown, index: number): ValidationFieldError | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return { field: `itemResults[${index}]`, message: 'must be an object' };
  }
  const record = raw as Record<string, unknown>;
  if (!isNonEmptyString(record.code)) {
    return {
      field: `itemResults[${index}].code`,
      message: 'is required and must be a non-empty string',
    };
  }
  if (typeof record.pass !== 'boolean') {
    return { field: `itemResults[${index}].pass`, message: 'is required and must be a boolean' };
  }
  if (record.note !== undefined && record.note !== null && typeof record.note !== 'string') {
    return { field: `itemResults[${index}].note`, message: 'must be a string when provided' };
  }
  return undefined;
}

function toItemResult(raw: unknown): ItemResult {
  const record = raw as Record<string, unknown>;
  return {
    code: record.code as string,
    pass: record.pass as boolean,
    note: typeof record.note === 'string' ? record.note : null,
  };
}

export function validateSubmitCheckBody(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: SubmitCheckInput }
  | { readonly ok: false; readonly errors: readonly ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];

  if (!isNonEmptyString(body.templateId)) {
    errors.push({ field: 'templateId', message: 'is required and must be a non-empty string' });
  }
  if (!isNonEmptyString(body.completedBy)) {
    errors.push({ field: 'completedBy', message: 'is required and must be a non-empty string' });
  }
  if (!isFiniteNumber(body.completedAt)) {
    errors.push({
      field: 'completedAt',
      message: 'is required and must be a finite number (epoch)',
    });
  }
  if (!isFiniteNumber(body.durationSeconds) || body.durationSeconds < 0) {
    errors.push({
      field: 'durationSeconds',
      message: 'is required and must be a non-negative finite number',
    });
  }
  if (!isNonEmptyString(body.idempotencyKey)) {
    errors.push({ field: 'idempotencyKey', message: 'is required and must be a non-empty string' });
  }
  if (body.capturedOffline !== undefined && typeof body.capturedOffline !== 'boolean') {
    errors.push({ field: 'capturedOffline', message: 'must be a boolean when provided' });
  }

  if (!Array.isArray(body.itemResults) || body.itemResults.length === 0) {
    errors.push({ field: 'itemResults', message: 'is required and must be a non-empty array' });
  } else {
    body.itemResults.forEach((raw, index) => {
      const error = validateItemResult(raw, index);
      if (error) {
        errors.push(error);
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      templateId: body.templateId as string,
      completedBy: body.completedBy as string,
      completedAt: body.completedAt as number,
      durationSeconds: body.durationSeconds as number,
      idempotencyKey: body.idempotencyKey as string,
      capturedOffline: body.capturedOffline === true,
      itemResults: (body.itemResults as unknown[]).map(toItemResult),
    },
  };
}

export function buildChecklistRunItem(
  deptId: VerifiedDeptId,
  apparatusId: string,
  input: SubmitCheckInput,
): ChecklistRunItem {
  return {
    pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
    sk: `${CHECK_SK_PREFIX}${input.completedAt}`,
    entityType: 'CHECKLIST_RUN',
    templateId: input.templateId,
    completedBy: input.completedBy,
    completedAt: input.completedAt,
    durationSeconds: input.durationSeconds,
    itemResults: input.itemResults,
    defectIds: [],
    capturedOffline: input.capturedOffline,
    syncedAt: input.capturedOffline ? Math.floor(Date.now() / 1000) : null,
    idempotencyKey: input.idempotencyKey,
    gsi3pk: buildDeptScopedPk(deptId, 'CHECKLIST_RUN'),
    gsi3sk: `${input.completedAt}`,
  };
}

export function buildChecklistIdempotencyLockItem(
  deptId: VerifiedDeptId,
  idempotencyKey: string,
  checkSk: string,
): ChecklistRunItem {
  return {
    pk: buildDeptScopedPk(deptId, 'CHECK_IDEMPOTENCY', idempotencyKey),
    sk: 'LOCK',
    entityType: 'CHECK_IDEMPOTENCY_LOCK',
    idempotencyKey,
    checkSk,
  };
}

export function buildChecklistAuditEntry(
  deptId: VerifiedDeptId,
  apparatusId: string,
  completedAt: number,
  actorId: string,
  ts: number,
): ChecklistRunItem {
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const mutatedEntityId = `${apparatusId}-${completedAt}`;
  return {
    pk: buildDeptScopedPk(deptId, 'AUDIT', date),
    sk: `${ts}#CHECKLIST_RUN#${mutatedEntityId}#${actorId}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: 'CHECKLIST_RUN',
    mutatedEntityId,
    action: 'CREATE',
    actorId,
    ts,
  };
}

export function parseChecklistRunItem(
  item: ChecklistRunItem,
  apparatusId: string,
  deptId: string,
): ChecklistRun {
  return {
    apparatusId,
    deptId,
    templateId: String(item.templateId),
    completedBy: String(item.completedBy),
    completedAt: Number(item.completedAt),
    durationSeconds: Number(item.durationSeconds),
    itemResults: (item.itemResults as ItemResult[]) ?? [],
    defectIds: Array.isArray(item.defectIds) ? (item.defectIds as string[]) : [],
    capturedOffline: item.capturedOffline === true,
    syncedAt: item.syncedAt === null || item.syncedAt === undefined ? null : Number(item.syncedAt),
  };
}
