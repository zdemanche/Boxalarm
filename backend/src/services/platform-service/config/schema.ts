import type { DepartmentConfigType } from './repository.js';

/**
 * Per-configType shape validation for `PUT /config/{configType}`.
 *
 * Shapes are inferred from how each configType is actually consumed elsewhere
 * in the codebase (see review notes on PR #145 / E8-S4):
 *  - RETENTION mirrors `RetentionConfigValue` in
 *    `platform-service/retention/configRepository.ts` (`{ retentionYears }`).
 *  - LOSAP_POINT_RULES mirrors the `pointsByActivityType` map written by
 *    `personnel-service/losap/configRepository.ts`.
 *  - ALERT_RULES mirrors the fields actually read back out of this configType,
 *    e.g. `certExpiryLeadDays` in
 *    `training-service/certificationExpiryScanner/configReader.ts`.
 *  - CHECKLIST_DEFAULTS mirrors the `ChecklistItem` shape used for
 *    `CHECKLIST_TEMPLATE` records in `apparatus-service/checklistResolution.ts`.
 *  - STATIONS/RANKS have no existing reader in this repo yet; their shapes
 *    follow the `stationId`/`rank` free-text conventions already used by
 *    `personnel-service/shifts` and `personnel-service` member records.
 */

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unknownFieldErrors(
  value: Record<string, unknown>,
  known: readonly string[],
  prefix = '',
): FieldError[] {
  return Object.keys(value)
    .filter((key) => !known.includes(key))
    .map((key) => ({ field: `${prefix}${key}`, message: 'is not a recognized field' }));
}

function validateStations(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ['stations'])];
  if (!Array.isArray(value.stations)) {
    errors.push({ field: 'stations', message: 'is required and must be an array' });
    return errors;
  }
  value.stations.forEach((station, index) => {
    const prefix = `stations[${index}]`;
    if (!isPlainObject(station)) {
      errors.push({ field: prefix, message: 'must be an object' });
      return;
    }
    if (!isNonEmptyString(station.stationId)) {
      errors.push({
        field: `${prefix}.stationId`,
        message: 'is required and must be a non-empty string',
      });
    }
    if (!isNonEmptyString(station.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'is required and must be a non-empty string',
      });
    }
    if (station.address !== undefined && !isNonEmptyString(station.address)) {
      errors.push({
        field: `${prefix}.address`,
        message: 'must be a non-empty string when provided',
      });
    }
    errors.push(...unknownFieldErrors(station, ['stationId', 'name', 'address'], `${prefix}.`));
  });
  return errors;
}

function validateRanks(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ['ranks'])];
  if (!Array.isArray(value.ranks) || value.ranks.length === 0) {
    errors.push({
      field: 'ranks',
      message: 'is required and must be a non-empty array of strings',
    });
    return errors;
  }
  value.ranks.forEach((rank, index) => {
    if (!isNonEmptyString(rank)) {
      errors.push({ field: `ranks[${index}]`, message: 'must be a non-empty string' });
    }
  });
  return errors;
}

function validateLosapPointRules(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ['pointsByActivityType'])];
  if (!isPlainObject(value.pointsByActivityType)) {
    errors.push({
      field: 'pointsByActivityType',
      message: 'is required and must be an object',
    });
    return errors;
  }
  const entries = Object.entries(value.pointsByActivityType);
  if (entries.length === 0) {
    errors.push({
      field: 'pointsByActivityType',
      message: 'must have at least one activity type entry',
    });
  }
  for (const [activityType, points] of entries) {
    if (!isFiniteNumber(points) || points < 0) {
      errors.push({
        field: `pointsByActivityType.${activityType}`,
        message: 'must be a non-negative finite number',
      });
    }
  }
  return errors;
}

const ALERT_RULES_KNOWN_FIELDS = ['escalationThresholdN', 'certExpiryLeadDays'] as const;

function validateAlertRules(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ALERT_RULES_KNOWN_FIELDS)];
  if (value.escalationThresholdN !== undefined) {
    if (
      typeof value.escalationThresholdN !== 'number' ||
      !Number.isInteger(value.escalationThresholdN) ||
      value.escalationThresholdN < 1
    ) {
      errors.push({
        field: 'escalationThresholdN',
        message: 'must be a positive integer when provided',
      });
    }
  }
  if (value.certExpiryLeadDays !== undefined) {
    if (!isFiniteNumber(value.certExpiryLeadDays) || value.certExpiryLeadDays <= 0) {
      errors.push({
        field: 'certExpiryLeadDays',
        message: 'must be a positive number when provided',
      });
    }
  }
  if (value.escalationThresholdN === undefined && value.certExpiryLeadDays === undefined) {
    errors.push({
      field: 'value',
      message: `must include at least one of ${ALERT_RULES_KNOWN_FIELDS.join(', ')}`,
    });
  }
  return errors;
}

function validateChecklistDefaults(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ['items'])];
  if (!Array.isArray(value.items) || value.items.length === 0) {
    errors.push({ field: 'items', message: 'is required and must be a non-empty array' });
    return errors;
  }
  value.items.forEach((item, index) => {
    const prefix = `items[${index}]`;
    if (!isPlainObject(item)) {
      errors.push({ field: prefix, message: 'must be an object' });
      return;
    }
    if (!isNonEmptyString(item.code)) {
      errors.push({
        field: `${prefix}.code`,
        message: 'is required and must be a non-empty string',
      });
    }
    if (!isNonEmptyString(item.label)) {
      errors.push({
        field: `${prefix}.label`,
        message: 'is required and must be a non-empty string',
      });
    }
    if (typeof item.requiresPhoto !== 'boolean') {
      errors.push({
        field: `${prefix}.requiresPhoto`,
        message: 'is required and must be a boolean',
      });
    }
    errors.push(...unknownFieldErrors(item, ['code', 'label', 'requiresPhoto'], `${prefix}.`));
  });
  return errors;
}

function validateRetention(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ['retentionYears'])];
  if (
    typeof value.retentionYears !== 'number' ||
    !Number.isInteger(value.retentionYears) ||
    value.retentionYears < 1
  ) {
    errors.push({
      field: 'retentionYears',
      message: 'is required and must be a positive integer',
    });
  }
  return errors;
}

/**
 * Validates `body.value` for a PUT against its configType's shape. Returns an
 * empty array when the value is valid, otherwise a list of field-level errors.
 */
export function validateConfigValue(
  configType: DepartmentConfigType,
  value: Record<string, unknown>,
): FieldError[] {
  switch (configType) {
    case 'STATIONS':
      return validateStations(value);
    case 'RANKS':
      return validateRanks(value);
    case 'LOSAP_POINT_RULES':
      return validateLosapPointRules(value);
    case 'ALERT_RULES':
      return validateAlertRules(value);
    case 'CHECKLIST_DEFAULTS':
      return validateChecklistDefaults(value);
    case 'RETENTION':
      return validateRetention(value);
  }
}
