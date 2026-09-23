import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export type SourceSystem = 'CAD' | 'MANUAL' | 'SELF_TEST';

export interface DispatchReceived {
  readonly sourceSystem: SourceSystem;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly unitsRequested: readonly string[];
  readonly narrative: string;
  readonly externalDispatchId: string;
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type NormalizeResult =
  | { readonly ok: true; readonly value: DispatchReceived }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

export interface DispatchIngressPort {
  readonly sourceSystem: SourceSystem;
  normalize(rawPayload: unknown): NormalizeResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field, message: `${field} is required and must be a non-empty string` });
    return '';
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): readonly string[] {
  const value = body[field];
  if (value === undefined) {
    return [];
  }
  if (!isStringArray(value)) {
    errors.push({ field, message: `${field} must be an array of strings when present` });
    return [];
  }
  return value;
}

export function normalizeManualEntry(rawPayload: unknown): NormalizeResult {
  if (!isRecord(rawPayload)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'request body must be a JSON object' }],
    };
  }

  const errors: FieldError[] = [];
  const incidentType = requiredString(rawPayload, 'incidentType', errors);
  const address = requiredString(rawPayload, 'address', errors);
  const crossStreets = requiredString(rawPayload, 'crossStreets', errors);
  const narrative = requiredString(rawPayload, 'narrative', errors);
  const externalDispatchId = requiredString(rawPayload, 'externalDispatchId', errors);
  const unitsRequested = optionalStringArray(rawPayload, 'unitsRequested', errors);

  if (externalDispatchId.includes('#')) {
    errors.push({
      field: 'externalDispatchId',
      message: "externalDispatchId cannot contain '#', the department-scoped pk delimiter",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      sourceSystem: 'MANUAL',
      incidentType,
      address,
      crossStreets,
      unitsRequested,
      narrative,
      externalDispatchId,
    },
  };
}

export const manualEntryAdapter: DispatchIngressPort = {
  sourceSystem: 'MANUAL',
  normalize: normalizeManualEntry,
};

export function deriveIngressIdempotencyKey(
  deptId: VerifiedDeptId,
  sourceSystem: SourceSystem,
  externalDispatchId: string,
): string {
  return `${sourceSystem}#${deptId}#${externalDispatchId}`;
}
