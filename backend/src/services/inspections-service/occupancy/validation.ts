import type { ProblemDetailsFieldError } from './problemDetails.js';

export class ValidationError extends Error {
  constructor(public readonly errors: readonly ProblemDetailsFieldError[]) {
    super('occupancy input validation failed');
  }
}

export interface OccupancyContact {
  readonly name: string;
  readonly phone: string;
  readonly role: string;
}

export interface CreateOccupancyInput {
  readonly address: string;
  readonly normalizedAddress: string;
  readonly occupancyType: string;
  readonly contacts: readonly OccupancyContact[];
  readonly hazards: readonly string[];
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface UpdateOccupancyInput {
  readonly contacts?: readonly OccupancyContact[];
  readonly hazards?: readonly string[];
}

export function normalizeAddress(address: string): string {
  return address.trim().replace(/\s+/g, ' ').toUpperCase();
}

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOccupancyRequestBody(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError([{ field: 'body', message: 'must be valid JSON' }]);
  }
  if (!isRecord(parsed)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  return parsed;
}

function validateNonEmptyString(
  value: unknown,
  field: string,
  errors: ProblemDetailsFieldError[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field, message: 'must be a non-empty string' });
    return undefined;
  }
  if (value.length > MAX_STRING_LENGTH) {
    errors.push({ field, message: `must be at most ${MAX_STRING_LENGTH} characters` });
    return undefined;
  }
  return value;
}

function validateFiniteNumber(
  value: unknown,
  field: string,
  errors: ProblemDetailsFieldError[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field, message: 'must be a finite number' });
    return undefined;
  }
  return value;
}

function validateOptionalFiniteNumber(
  value: unknown,
  field: string,
  errors: ProblemDetailsFieldError[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateFiniteNumber(value, field, errors);
}

function validateContacts(
  value: unknown,
  field: string,
  errors: ProblemDetailsFieldError[],
): readonly OccupancyContact[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be an array' });
    return undefined;
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    errors.push({ field, message: `must have at most ${MAX_ARRAY_LENGTH} entries` });
    return undefined;
  }
  const contacts: OccupancyContact[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push({ field: `${field}[${index}]`, message: 'must be an object' });
      return;
    }
    const name = validateNonEmptyString(entry.name, `${field}[${index}].name`, errors);
    const phone = validateNonEmptyString(entry.phone, `${field}[${index}].phone`, errors);
    const role = validateNonEmptyString(entry.role, `${field}[${index}].role`, errors);
    if (name !== undefined && phone !== undefined && role !== undefined) {
      contacts.push({ name, phone, role });
    }
  });
  return contacts;
}

function validateHazards(
  value: unknown,
  field: string,
  errors: ProblemDetailsFieldError[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be an array' });
    return undefined;
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    errors.push({ field, message: `must have at most ${MAX_ARRAY_LENGTH} entries` });
    return undefined;
  }
  const hazards: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      errors.push({ field: `${field}[${index}]`, message: 'must be a non-empty string' });
      return;
    }
    if (entry.length > MAX_STRING_LENGTH) {
      errors.push({
        field: `${field}[${index}]`,
        message: `must be at most ${MAX_STRING_LENGTH} characters`,
      });
      return;
    }
    hazards.push(entry);
  });
  return hazards;
}

export function validateCreateOccupancyInput(body: Record<string, unknown>): CreateOccupancyInput {
  const errors: ProblemDetailsFieldError[] = [];
  const address = validateNonEmptyString(body.address, 'address', errors);
  const occupancyType = validateNonEmptyString(body.occupancyType, 'occupancyType', errors);
  const contacts = validateContacts(body.contacts, 'contacts', errors);
  const hazards = validateHazards(body.hazards, 'hazards', errors);
  const latitude = validateOptionalFiniteNumber(body.latitude, 'latitude', errors);
  const longitude = validateOptionalFiniteNumber(body.longitude, 'longitude', errors);

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return {
    address: address as string,
    normalizedAddress: normalizeAddress(address as string),
    occupancyType: occupancyType as string,
    contacts: contacts as readonly OccupancyContact[],
    hazards: hazards as readonly string[],
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
  };
}

export function validateUpdateOccupancyInput(body: Record<string, unknown>): UpdateOccupancyInput {
  const errors: ProblemDetailsFieldError[] = [];
  const hasContacts = Object.prototype.hasOwnProperty.call(body, 'contacts');
  const hasHazards = Object.prototype.hasOwnProperty.call(body, 'hazards');

  if (!hasContacts && !hasHazards) {
    throw new ValidationError([
      { field: 'body', message: 'at least one of contacts or hazards is required' },
    ]);
  }

  let contacts: readonly OccupancyContact[] | undefined;
  if (hasContacts) {
    if (body.contacts === null) {
      errors.push({ field: 'contacts', message: 'must be an array or omitted' });
    } else {
      contacts = validateContacts(body.contacts, 'contacts', errors);
    }
  }

  let hazards: readonly string[] | undefined;
  if (hasHazards) {
    if (body.hazards === null) {
      errors.push({ field: 'hazards', message: 'must be an array or omitted' });
    } else {
      hazards = validateHazards(body.hazards, 'hazards', errors);
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return {
    ...(contacts !== undefined ? { contacts } : {}),
    ...(hazards !== undefined ? { hazards } : {}),
  };
}
