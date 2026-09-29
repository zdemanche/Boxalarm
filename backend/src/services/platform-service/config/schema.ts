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

/**
 * ALERT_RULES. `escalationThresholdN` (seconds before a member's voice escalation) and the
 * tone-ladder fields are projected into the alerting plane's ALERT_RULES_COPY by its own
 * consumer (alerting-service alertRules/alertRulesCopyHandler.ts), which the escalation
 * scheduler and the tone evaluator read; `certExpiryLeadDays` is read by training-service.
 *  - toneLadder: { tone2AtSeconds, tone3AtSeconds } - when tones 2 and 3 are evaluated;
 *  - defaultRule: { minResponders, requiredQuals } - the predicate that stops the ladder:
 *    at least minResponders answered RESPONDING / DIRECT_TO_SCENE holding one of requiredQuals
 *    (any qual when empty).
 */
const ALERT_RULES_KNOWN_FIELDS = [
  'escalationThresholdN',
  'certExpiryLeadDays',
  'toneLadder',
  'defaultRule',
] as const;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function validateToneLadder(value: unknown): FieldError[] {
  if (!isPlainObject(value)) {
    return [{ field: 'toneLadder', message: 'must be an object when provided' }];
  }
  const errors = unknownFieldErrors(value, ['tone2AtSeconds', 'tone3AtSeconds'], 'toneLadder.');
  for (const field of ['tone2AtSeconds', 'tone3AtSeconds'] as const) {
    if (value[field] !== undefined && !isPositiveInteger(value[field])) {
      errors.push({ field: `toneLadder.${field}`, message: 'must be a positive integer' });
    }
  }
  if (
    isPositiveInteger(value.tone2AtSeconds) &&
    isPositiveInteger(value.tone3AtSeconds) &&
    value.tone3AtSeconds <= value.tone2AtSeconds
  ) {
    errors.push({ field: 'toneLadder.tone3AtSeconds', message: 'must be after tone2AtSeconds' });
  }
  return errors;
}

function validateDefaultRule(value: unknown): FieldError[] {
  if (!isPlainObject(value)) {
    return [{ field: 'defaultRule', message: 'must be an object when provided' }];
  }
  const errors = unknownFieldErrors(value, ['minResponders', 'requiredQuals'], 'defaultRule.');
  if (value.minResponders !== undefined && !isPositiveInteger(value.minResponders)) {
    errors.push({ field: 'defaultRule.minResponders', message: 'must be a positive integer' });
  }
  if (
    value.requiredQuals !== undefined &&
    (!Array.isArray(value.requiredQuals) || !value.requiredQuals.every(isNonEmptyString))
  ) {
    errors.push({
      field: 'defaultRule.requiredQuals',
      message: 'must be an array of qualification codes',
    });
  }
  return errors;
}

function validateAlertRules(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, ALERT_RULES_KNOWN_FIELDS)];
  if (value.escalationThresholdN !== undefined) {
    if (!isPositiveInteger(value.escalationThresholdN)) {
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
  if (value.toneLadder !== undefined) {
    errors.push(...validateToneLadder(value.toneLadder));
  }
  if (value.defaultRule !== undefined) {
    errors.push(...validateDefaultRule(value.defaultRule));
  }
  if (ALERT_RULES_KNOWN_FIELDS.every((field) => value[field] === undefined)) {
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

function validateRidingPositions(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  for (const [apparatusType, positions] of Object.entries(value)) {
    const prefix = apparatusType;
    if (!Array.isArray(positions)) {
      errors.push({ field: prefix, message: 'must be an array of riding positions' });
      continue;
    }
    positions.forEach((position, index) => {
      const positionPrefix = `${prefix}[${index}]`;
      if (!isPlainObject(position)) {
        errors.push({ field: positionPrefix, message: 'must be an object' });
        return;
      }
      if (!isNonEmptyString(position.code)) {
        errors.push({
          field: `${positionPrefix}.code`,
          message: 'is required and must be a non-empty string',
        });
      }
      if (!isNonEmptyString(position.label)) {
        errors.push({
          field: `${positionPrefix}.label`,
          message: 'is required and must be a non-empty string',
        });
      }
      if (position.requiredQual !== undefined && !isNonEmptyString(position.requiredQual)) {
        errors.push({
          field: `${positionPrefix}.requiredQual`,
          message: 'must be a non-empty string when provided',
        });
      }
      errors.push(
        ...unknownFieldErrors(position, ['code', 'label', 'requiredQual'], `${positionPrefix}.`),
      );
    });
  }
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

const NERIS_KNOWN_FIELDS = [
  'departmentNerisId',
  'autoSubmitOnLock',
  'submissionsEnabled',
  'rules',
  'timeZone',
] as const;
const NERIS_RULE_FIELDS = ['requireNarrative', 'minNarrativeLength', 'requireUnitTimes'] as const;

/**
 * NERIS reporting settings, read by incident-service through its projected copy
 * (incident-service/nerisSettings.ts): the department's NERIS entity id, whether an
 * officer's lock submits straight away, a submission kill switch, and the department's own
 * pre-lock rules on top of NERIS's.
 */
function validateNeris(value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [...unknownFieldErrors(value, NERIS_KNOWN_FIELDS)];
  if (typeof value.departmentNerisId !== 'string' || !/^FD\d{8}$/.test(value.departmentNerisId)) {
    errors.push({
      field: 'departmentNerisId',
      message: 'is required and must be the NERIS department id: FD followed by 8 digits',
    });
  }
  for (const field of ['autoSubmitOnLock', 'submissionsEnabled'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      errors.push({ field, message: 'must be a boolean when provided' });
    }
  }
  if (value.timeZone !== undefined) {
    let valid = typeof value.timeZone === 'string' && value.timeZone.length > 0;
    if (valid) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone as string });
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      errors.push({
        field: 'timeZone',
        message: 'must be an IANA time zone such as America/New_York when provided',
      });
    }
  }
  if (value.rules !== undefined) {
    if (!isPlainObject(value.rules)) {
      errors.push({ field: 'rules', message: 'must be an object when provided' });
    } else {
      const rules = value.rules;
      errors.push(...unknownFieldErrors(rules, NERIS_RULE_FIELDS, 'rules.'));
      for (const field of ['requireNarrative', 'requireUnitTimes'] as const) {
        if (rules[field] !== undefined && typeof rules[field] !== 'boolean') {
          errors.push({ field: `rules.${field}`, message: 'must be a boolean when provided' });
        }
      }
      const min = rules.minNarrativeLength;
      if (
        min !== undefined &&
        (typeof min !== 'number' || !Number.isInteger(min) || min < 0 || min > 100_000)
      ) {
        errors.push({
          field: 'rules.minNarrativeLength',
          message: 'must be an integer from 0 to 100000 when provided',
        });
      }
    }
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
    case 'RIDING_POSITIONS':
      return validateRidingPositions(value);
    case 'NERIS':
      return validateNeris(value);
  }
}
