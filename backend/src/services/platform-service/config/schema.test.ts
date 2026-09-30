import { describe, expect, it } from 'vitest';
import { validateConfigValue } from './schema.js';

describe('validateConfigValue', () => {
  describe('STATIONS', () => {
    it('accepts a well-formed stations list', () => {
      const errors = validateConfigValue('STATIONS', {
        stations: [{ stationId: 'STA-1', name: 'Station 1', address: '1 Main St' }],
      });
      expect(errors).toEqual([]);
    });

    it('rejects a missing stations array', () => {
      const errors = validateConfigValue('STATIONS', {});
      expect(errors).toContainEqual({
        field: 'stations',
        message: 'is required and must be an array',
      });
    });

    it('rejects a station entry missing required fields', () => {
      const errors = validateConfigValue('STATIONS', { stations: [{}] });
      expect(errors).toContainEqual({
        field: 'stations[0].stationId',
        message: 'is required and must be a non-empty string',
      });
      expect(errors).toContainEqual({
        field: 'stations[0].name',
        message: 'is required and must be a non-empty string',
      });
    });

    it('rejects unrecognized top-level fields', () => {
      const errors = validateConfigValue('STATIONS', {
        stations: [],
        injected: { escalationThresholdN: 999999 },
      });
      expect(errors).toContainEqual({
        field: 'injected',
        message: 'is not a recognized field',
      });
    });
  });

  describe('RANKS', () => {
    it('accepts a non-empty list of rank strings', () => {
      expect(validateConfigValue('RANKS', { ranks: ['FF', 'LT', 'CAPT'] })).toEqual([]);
    });

    it('rejects an empty ranks array', () => {
      const errors = validateConfigValue('RANKS', { ranks: [] });
      expect(errors).toContainEqual({
        field: 'ranks',
        message: 'is required and must be a non-empty array of strings',
      });
    });

    it('rejects non-string entries', () => {
      const errors = validateConfigValue('RANKS', { ranks: ['FF', 7] });
      expect(errors).toContainEqual({ field: 'ranks[1]', message: 'must be a non-empty string' });
    });
  });

  describe('LOSAP_POINT_RULES', () => {
    it('accepts a valid points map', () => {
      const errors = validateConfigValue('LOSAP_POINT_RULES', {
        pointsByActivityType: { TRAINING: 1, RESPONSE: 2 },
      });
      expect(errors).toEqual([]);
    });

    it('rejects a missing pointsByActivityType object', () => {
      const errors = validateConfigValue('LOSAP_POINT_RULES', {});
      expect(errors).toContainEqual({
        field: 'pointsByActivityType',
        message: 'is required and must be an object',
      });
    });

    it('rejects negative or non-numeric point values', () => {
      const errors = validateConfigValue('LOSAP_POINT_RULES', {
        pointsByActivityType: { TRAINING: -1, RESPONSE: 'two' },
      });
      expect(errors).toContainEqual({
        field: 'pointsByActivityType.TRAINING',
        message: 'must be a non-negative finite number',
      });
      expect(errors).toContainEqual({
        field: 'pointsByActivityType.RESPONSE',
        message: 'must be a non-negative finite number',
      });
    });
  });

  describe('ALERT_RULES', () => {
    it('accepts a valid escalationThresholdN', () => {
      expect(validateConfigValue('ALERT_RULES', { escalationThresholdN: 90 })).toEqual([]);
    });

    it('accepts a valid certExpiryLeadDays', () => {
      expect(validateConfigValue('ALERT_RULES', { certExpiryLeadDays: 30 })).toEqual([]);
    });

    it('rejects an empty object with no recognized fields', () => {
      const errors = validateConfigValue('ALERT_RULES', {});
      expect(errors).toContainEqual({
        field: 'value',
        message:
          'must include at least one of escalationThresholdN, certExpiryLeadDays, toneLadder, defaultRule',
      });
    });

    it('rejects a non-integer or non-positive escalationThresholdN', () => {
      const errors = validateConfigValue('ALERT_RULES', { escalationThresholdN: 0 });
      expect(errors).toContainEqual({
        field: 'escalationThresholdN',
        message: 'must be a whole number of seconds from 30 to 900',
      });
    });

    it('rejects arbitrary unrecognized fields (regression: PR #145 accepted arbitrary JSON)', () => {
      const errors = validateConfigValue('ALERT_RULES', {
        escalationThresholdN: 90,
        arbitraryField: { nested: 'payload' },
      });
      expect(errors).toContainEqual({
        field: 'arbitraryField',
        message: 'is not a recognized field',
      });
    });
  });

  // Design review M1: the tone ladder and its predicate are department config the alerting
  // plane projects into ALERT_RULES_COPY; before, they could not even be set.
  describe('ALERT_RULES tone ladder and predicate', () => {
    it('accepts the tone ladder timing and the stopping predicate', () => {
      expect(
        validateConfigValue('ALERT_RULES', {
          toneLadder: { tone2AtSeconds: 120, tone3AtSeconds: 300 },
          defaultRule: { minResponders: 3, requiredQuals: ['INTERIOR'] },
        }),
      ).toEqual([]);
    });

    it.each([
      [{ escalationThresholdN: 1 }, 'escalationThresholdN'],
      [{ toneLadder: { tone2AtSeconds: 400 } }, 'toneLadder.tone3AtSeconds'],
      [{ toneLadder: { tone3AtSeconds: 120 } }, 'toneLadder.tone3AtSeconds'],
      [{ toneLadder: { tone2AtSeconds: 18_000 } }, 'toneLadder.tone2AtSeconds'],
      [{ defaultRule: { minResponders: 500 } }, 'defaultRule.minResponders'],
      [{ toneLadder: { tone2AtSeconds: 0 } }, 'toneLadder.tone2AtSeconds'],
      [{ toneLadder: { tone2AtSeconds: 300, tone3AtSeconds: 200 } }, 'toneLadder.tone3AtSeconds'],
      [{ toneLadder: { tone4AtSeconds: 900 } }, 'toneLadder.tone4AtSeconds'],
      [{ toneLadder: 'soon' }, 'toneLadder'],
      [{ defaultRule: { minResponders: 1.5 } }, 'defaultRule.minResponders'],
      [{ defaultRule: { requiredQuals: [''] } }, 'defaultRule.requiredQuals'],
      [{ defaultRule: { requiredQuals: { INTERIOR: 2 } } }, 'defaultRule.requiredQuals'],
    ])('rejects %j (%s)', (value, field) => {
      expect(validateConfigValue('ALERT_RULES', value).map((error) => error.field)).toContain(
        field,
      );
    });
  });

  describe('CHECKLIST_DEFAULTS', () => {
    it('accepts a valid checklist item list', () => {
      const errors = validateConfigValue('CHECKLIST_DEFAULTS', {
        items: [{ code: 'OIL', label: 'Check oil', requiresPhoto: true }],
      });
      expect(errors).toEqual([]);
    });

    it('rejects an empty items array', () => {
      const errors = validateConfigValue('CHECKLIST_DEFAULTS', { items: [] });
      expect(errors).toContainEqual({
        field: 'items',
        message: 'is required and must be a non-empty array',
      });
    });

    it('rejects an item missing requiresPhoto', () => {
      const errors = validateConfigValue('CHECKLIST_DEFAULTS', {
        items: [{ code: 'OIL', label: 'Check oil' }],
      });
      expect(errors).toContainEqual({
        field: 'items[0].requiresPhoto',
        message: 'is required and must be a boolean',
      });
    });

    it('accepts critical: true and false on an item', () => {
      const errors = validateConfigValue('CHECKLIST_DEFAULTS', {
        items: [
          { code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: true },
          { code: 'OIL', label: 'Check oil', requiresPhoto: true, critical: false },
        ],
      });
      expect(errors).toEqual([]);
    });

    it('rejects a non-boolean critical', () => {
      const errors = validateConfigValue('CHECKLIST_DEFAULTS', {
        items: [{ code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: 'yes' }],
      });
      expect(errors).toContainEqual({
        field: 'items[0].critical',
        message: 'must be a boolean when provided',
      });
    });
  });

  describe('RETENTION', () => {
    it('accepts a positive integer retentionYears', () => {
      expect(validateConfigValue('RETENTION', { retentionYears: 7 })).toEqual([]);
    });

    it('rejects a missing retentionYears', () => {
      const errors = validateConfigValue('RETENTION', {});
      expect(errors).toContainEqual({
        field: 'retentionYears',
        message: 'is required and must be a positive integer',
      });
    });

    it('rejects a non-integer retentionYears', () => {
      const errors = validateConfigValue('RETENTION', { retentionYears: 2.5 });
      expect(errors).toContainEqual({
        field: 'retentionYears',
        message: 'is required and must be a positive integer',
      });
    });

    it('rejects a zero or negative retentionYears', () => {
      const errors = validateConfigValue('RETENTION', { retentionYears: 0 });
      expect(errors).toContainEqual({
        field: 'retentionYears',
        message: 'is required and must be a positive integer',
      });
    });

    it('rejects arbitrary unrecognized fields controlling data-lifecycle behavior', () => {
      const errors = validateConfigValue('RETENTION', {
        retentionYears: 7,
        purgeImmediately: true,
      });
      expect(errors).toContainEqual({
        field: 'purgeImmediately',
        message: 'is not a recognized field',
      });
    });
  });

  describe('NERIS', () => {
    it('accepts a department id with optional switches and rules', () => {
      expect(
        validateConfigValue('NERIS', {
          departmentNerisId: 'FD09190828',
          autoSubmitOnLock: true,
          submissionsEnabled: true,
          rules: { requireNarrative: true, minNarrativeLength: 40, requireUnitTimes: false },
        }),
      ).toEqual([]);
    });

    it('requires a well-formed NERIS department id', () => {
      expect(validateConfigValue('NERIS', { departmentNerisId: 'VN12345678' })).toContainEqual({
        field: 'departmentNerisId',
        message: 'is required and must be the NERIS department id: FD followed by 8 digits',
      });
    });

    it('rejects wrong types and unknown rule fields', () => {
      const errors = validateConfigValue('NERIS', {
        departmentNerisId: 'FD09190828',
        autoSubmitOnLock: 'yes',
        rules: { minNarrativeLength: -1, skipValidation: true },
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          { field: 'autoSubmitOnLock', message: 'must be a boolean when provided' },
          {
            field: 'rules.minNarrativeLength',
            message: 'must be an integer from 0 to 100000 when provided',
          },
          { field: 'rules.skipValidation', message: 'is not a recognized field' },
        ]),
      );
    });
  });
});
