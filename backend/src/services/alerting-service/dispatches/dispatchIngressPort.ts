import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export type SourceSystem = 'CAD' | 'MANUAL' | 'SELF_TEST';

/**
 * Where the incident is, as the dispatcher chose it: one of the department's home towns or
 * villages (HOME), or another town typed in (OTHER). Enrichment only — the pre-plan lookup
 * uses it to confirm a street address is in this department's area; fan-out never reads it.
 */
export interface DispatchLocality {
  readonly town: string;
  readonly choice: 'HOME' | 'OTHER';
}

export const MAX_LOCALITY_TOWN_LENGTH = 80;

export interface DispatchReceived {
  readonly sourceSystem: SourceSystem;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly unitsRequested: readonly string[];
  readonly narrative: string;
  readonly externalDispatchId: string;
  /** Absent from callers that predate it (accepted; the pre-plan is then never verified). */
  readonly locality?: DispatchLocality;
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type NormalizeResult =
  | {
      readonly ok: true;
      readonly value: DispatchReceived;
      /** A malformed `locality` that was dropped rather than rejected (round-4 m1). */
      readonly droppedLocality?: FieldError;
    }
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

/**
 * The optional `locality` field. Absent is accepted (older callers). Present but malformed is
 * DROPPED, never a 400: locality is enrichment, and enrichment must never gate or delay a page
 * (round-4 m1). The dispatch is then treated as naming no locality, so any pre-plan shown for
 * it is flagged VERIFY ADDRESS. The caller logs and counts the drop.
 */
function optionalLocality(body: Record<string, unknown>): {
  readonly locality?: DispatchLocality;
  readonly dropped?: FieldError;
} {
  const value = body.locality;
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return {
      dropped: { field: 'locality', message: 'locality was not an object { town, choice }' },
    };
  }
  const town = typeof value.town === 'string' ? value.town.trim() : '';
  const hasControlCharacter = [...town].some((character) => character.charCodeAt(0) < 0x20);
  if (town.length === 0 || town.length > MAX_LOCALITY_TOWN_LENGTH || hasControlCharacter) {
    return {
      dropped: {
        field: 'locality.town',
        message: `locality.town was not a town name of 1-${MAX_LOCALITY_TOWN_LENGTH} characters`,
      },
    };
  }
  if (value.choice !== 'HOME' && value.choice !== 'OTHER') {
    return {
      dropped: { field: 'locality.choice', message: "locality.choice was not 'HOME' or 'OTHER'" },
    };
  }
  return { locality: { town, choice: value.choice } };
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
  const { locality, dropped } = optionalLocality(rawPayload);

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
      ...(locality ? { locality } : {}),
    },
    ...(dropped ? { droppedLocality: dropped } : {}),
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
