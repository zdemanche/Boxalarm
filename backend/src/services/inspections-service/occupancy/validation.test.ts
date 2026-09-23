import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  normalizeAddress,
  parseOccupancyRequestBody,
  validateCreateOccupancyInput,
  validateUpdateOccupancyInput,
} from './validation.js';

const validCreateBody = {
  address: '456 Oak Ave',
  occupancyType: 'MULTI_FAMILY',
  contacts: [{ name: 'Pat Smith', phone: '203-555-0100', role: 'OWNER' }],
  hazards: ['PROPANE_TANK'],
  latitude: 41.2415,
  longitude: -73.2004,
};

describe('normalizeAddress', () => {
  it('trims, collapses whitespace, and upper-cases', () => {
    expect(normalizeAddress('  456   Oak Ave  ')).toBe('456 OAK AVE');
  });
});

describe('parseOccupancyRequestBody', () => {
  it('returns an empty object for an absent body', () => {
    expect(parseOccupancyRequestBody(undefined)).toEqual({});
  });

  it('throws a ValidationError on malformed JSON', () => {
    expect(() => parseOccupancyRequestBody('{not json')).toThrow(ValidationError);
  });

  it('throws a ValidationError when the body is valid JSON but not an object', () => {
    expect(() => parseOccupancyRequestBody('"just a string"')).toThrow(ValidationError);
  });

  it('parses a valid JSON object body', () => {
    expect(parseOccupancyRequestBody('{"address":"1 Main St"}')).toEqual({ address: '1 Main St' });
  });
});

describe('validateCreateOccupancyInput', () => {
  it('accepts a fully populated routine input and normalizes the address', () => {
    const result = validateCreateOccupancyInput(validCreateBody);
    expect(result.address).toBe('456 Oak Ave');
    expect(result.normalizedAddress).toBe('456 OAK AVE');
    expect(result.occupancyType).toBe('MULTI_FAMILY');
    expect(result.contacts).toEqual(validCreateBody.contacts);
    expect(result.hazards).toEqual(['PROPANE_TANK']);
    expect(result.latitude).toBe(41.2415);
    expect(result.longitude).toBe(-73.2004);
  });

  it('accepts empty contacts and hazards arrays (routine input)', () => {
    const result = validateCreateOccupancyInput({ ...validCreateBody, contacts: [], hazards: [] });
    expect(result.contacts).toEqual([]);
    expect(result.hazards).toEqual([]);
  });

  it('rejects an absent address with a field-level error', () => {
    const { address, ...rest } = validCreateBody;
    void address;
    try {
      validateCreateOccupancyInput(rest);
      throw new Error('expected validateCreateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'address',
        message: 'must be a non-empty string',
      });
    }
  });

  it('rejects hazards that are the wrong type (a string instead of an array)', () => {
    try {
      validateCreateOccupancyInput({ ...validCreateBody, hazards: 'PROPANE_TANK' });
      throw new Error('expected validateCreateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'hazards',
        message: 'must be an array',
      });
    }
  });

  it('rejects a non-finite latitude', () => {
    expect(() => validateCreateOccupancyInput({ ...validCreateBody, latitude: 'north' })).toThrow(
      ValidationError,
    );
  });

  it('accepts the AC1 literal body with no coordinates (address, occupancyType, contacts, hazards only)', () => {
    const { latitude, longitude, ...ac1Body } = validCreateBody;
    void latitude;
    void longitude;
    const result = validateCreateOccupancyInput(ac1Body);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
    expect(result.address).toBe('456 Oak Ave');
  });

  it('rejects an address over the maximum string length', () => {
    try {
      validateCreateOccupancyInput({ ...validCreateBody, address: 'A'.repeat(501) });
      throw new Error('expected validateCreateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'address',
        message: 'must be at most 500 characters',
      });
    }
  });

  it('rejects a contacts array over the maximum entry count', () => {
    const contacts = Array.from({ length: 101 }, () => ({
      name: 'Pat Smith',
      phone: '203-555-0100',
      role: 'OWNER',
    }));
    try {
      validateCreateOccupancyInput({ ...validCreateBody, contacts });
      throw new Error('expected validateCreateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'contacts',
        message: 'must have at most 100 entries',
      });
    }
  });

  it('rejects a hazards array over the maximum entry count', () => {
    const hazards = Array.from({ length: 101 }, (_, index) => `HAZARD_${index}`);
    try {
      validateCreateOccupancyInput({ ...validCreateBody, hazards });
      throw new Error('expected validateCreateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'hazards',
        message: 'must have at most 100 entries',
      });
    }
  });

  it('rejects a hazards entry over the maximum string length', () => {
    try {
      validateCreateOccupancyInput({ ...validCreateBody, hazards: ['H'.repeat(501)] });
      throw new Error('expected validateCreateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'hazards[0]',
        message: 'must be at most 500 characters',
      });
    }
  });
});

describe('validateUpdateOccupancyInput', () => {
  it('accepts an update with only contacts changed', () => {
    const result = validateUpdateOccupancyInput({ contacts: validCreateBody.contacts });
    expect(result).toEqual({ contacts: validCreateBody.contacts });
  });

  it('accepts an update with only hazards changed', () => {
    const result = validateUpdateOccupancyInput({ hazards: ['FLAMMABLE_STORAGE'] });
    expect(result).toEqual({ hazards: ['FLAMMABLE_STORAGE'] });
  });

  it('rejects an absent-body no-op patch (matrix: no fields changed)', () => {
    try {
      validateUpdateOccupancyInput({});
      throw new Error('expected validateUpdateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'body',
        message: 'at least one of contacts or hazards is required',
      });
    }
  });

  it('rejects a null contacts value rather than treating it as omitted', () => {
    try {
      validateUpdateOccupancyInput({ contacts: null });
      throw new Error('expected validateUpdateOccupancyInput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors).toContainEqual({
        field: 'contacts',
        message: 'must be an array or omitted',
      });
    }
  });
});
