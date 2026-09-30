import { describe, expect, it } from 'vitest';
import {
  MAX_PATTERN_LENGTH,
  compileCadParser,
  dispatchTextFingerprint,
  parseCadText,
  validateCadParserTemplate,
  type CadParserTemplate,
} from './index.js';

const SAMPLE = [
  'TRUMBULL EMERGENCY COMMUNICATIONS',
  'INC#: 2026-004471',
  'DISPATCHED: 09/30/2026 03:12:44',
  'TYPE: STRUCTURE FIRE',
  'ADDRESS: 123 MAIN ST, NICHOLS',
  'X-ST: ELM ST / OAK AVE',
  'UNITS: E1, L2 R1',
  'NARRATIVE: CALLER REPORTS SMOKE FROM 2ND FLOOR',
  'OCCUPANTS BELIEVED OUT',
].join('\r\n');

const TEMPLATE: CadParserTemplate = {
  version: 3,
  fields: {
    incidentNumber: { pattern: 'INC#:\\s*([\\w-]+)' },
    dispatchTime: { label: 'DISPATCHED' },
    incidentType: { label: 'TYPE' },
    address: { pattern: '^ADDRESS:\\s*([^,\\n]+)' },
    town: { pattern: '^ADDRESS:[^,\\n]*,\\s*([^\\n]+)$' },
    crossStreets: { label: 'X-ST' },
    units: { label: 'UNITS' },
    narrative: { label: 'NARRATIVE' },
  },
};

describe('compileCadParser', () => {
  it('reads every field by label and by pattern', () => {
    const result = compileCadParser(TEMPLATE).parse(SAMPLE);
    expect(result).toEqual({
      status: 'PARSED',
      version: 3,
      fields: {
        incidentNumber: '2026-004471',
        dispatchTime: '09/30/2026 03:12:44',
        incidentType: 'STRUCTURE FIRE',
        address: '123 MAIN ST',
        town: 'NICHOLS',
        crossStreets: 'ELM ST / OAK AVE',
        units: 'E1, L2 R1',
        narrative: 'CALLER REPORTS SMOKE FROM 2ND FLOOR\nOCCUPANTS BELIEVED OUT',
      },
    });
  });

  it('matches labels case-insensitively and with a dash separator', () => {
    const parser = compileCadParser({ version: 1, fields: { address: { label: 'Location' } } });
    expect(parser.parse('location - 9 Oak Ave').status).toBe('PARSED');
  });

  it('fails OPEN to RAW, keeping what it found, when the address is missing', () => {
    const result = compileCadParser(TEMPLATE).parse('INC#: 77\nsomething unexpected');
    expect(result).toEqual({
      status: 'RAW',
      version: 3,
      reason: 'NO_ADDRESS',
      fields: { incidentNumber: '77' },
    });
  });

  it('treats blank text as RAW (EMPTY), never throws', () => {
    expect(compileCadParser(TEMPLATE).parse('  \r\n ')).toMatchObject({
      status: 'RAW',
      reason: 'EMPTY',
    });
  });

  it('caps a field value and strips control characters', () => {
    const long = `ADDRESS: 1 ${'A'.repeat(2000)}\u0007`;
    const result = compileCadParser({
      version: 1,
      fields: { address: { label: 'ADDRESS' } },
    }).parse(long);
    expect(result.fields.address?.length).toBe(500);
    expect(result.fields.address).not.toContain('\u0007');
  });
});

describe('parseCadText', () => {
  it('is RAW (NO_TEMPLATE) when the source has no template', () => {
    expect(parseCadText(undefined, 'ADDRESS: 1 MAIN')).toEqual({
      status: 'RAW',
      version: null,
      reason: 'NO_TEMPLATE',
      fields: {},
    });
  });
});

describe('validateCadParserTemplate', () => {
  it('accepts a valid template', () => {
    expect(validateCadParserTemplate(TEMPLATE)).toEqual({ ok: true, template: TEMPLATE });
  });

  it.each([
    [
      'an unknown field',
      { version: 1, fields: { address: { label: 'A' }, colour: { label: 'C' } } },
    ],
    ['both label and pattern', { version: 1, fields: { address: { label: 'A', pattern: 'x' } } }],
    ['an invalid regex', { version: 1, fields: { address: { pattern: '(' } } }],
    ['a nested quantifier', { version: 1, fields: { address: { pattern: '(\\w+)+$' } } }],
    [
      'an over-long pattern',
      { version: 1, fields: { address: { pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1) } } },
    ],
    ['no address rule', { version: 1, fields: { incidentType: { label: 'TYPE' } } }],
    ['a version below 1', { version: 0, fields: { address: { label: 'A' } } }],
    ['a label with a newline', { version: 1, fields: { address: { label: 'A\nB' } } }],
  ])('rejects %s', (_name, template) => {
    expect(validateCadParserTemplate(template).ok).toBe(false);
  });
});

describe('dispatchTextFingerprint', () => {
  it('ignores line endings, wrapping and case', () => {
    expect(dispatchTextFingerprint('ADDRESS: 1 Main\r\nTYPE: FIRE')).toBe(
      dispatchTextFingerprint('address: 1 main   type: fire\n'),
    );
  });

  it('differs for different text', () => {
    expect(dispatchTextFingerprint('A')).not.toBe(dispatchTextFingerprint('B'));
  });
});
