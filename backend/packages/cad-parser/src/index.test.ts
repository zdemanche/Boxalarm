import { describe, expect, it } from 'vitest';
import {
  MAX_PATTERN_LENGTH,
  compileCadParser,
  dispatchTextFingerprint,
  parseCadText,
  parseCadTextBounded,
  resolveCadMessageTime,
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

  it('keeps lower-case s/t and backslashes, collapses whitespace (the extractor source string)', () => {
    const parser = compileCadParser({
      version: 1,
      fields: { address: { label: 'ADDR' }, narrative: { label: 'NOTE' } },
    });
    expect(parser.parse('ADDR:  12  test\tst \\ rear\nNOTE: stairs\t\tlast').fields).toEqual({
      address: '12 test st \\ rear',
      narrative: 'stairs last',
    });
  });

  it('escapes regex metacharacters in a label', () => {
    const parser = compileCadParser({ version: 1, fields: { address: { label: 'LOC(1)' } } });
    expect(parser.parse('LOC(1): 5 ELM').fields.address).toBe('5 ELM');
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

describe('parseCadTextBounded (security review M3: a hard deadline, failing open to RAW)', () => {
  it('parses exactly like parseCadText when the template is well behaved', async () => {
    expect(await parseCadTextBounded(TEMPLATE, SAMPLE)).toEqual(parseCadText(TEMPLATE, SAMPLE));
  });

  it.each([
    ['((a)+)+$', 'a'.repeat(40) + '!'],
    ['(a|a)*$', 'a'.repeat(40) + '!'],
  ])('a catastrophic pattern %s times out to RAW instead of hanging', async (pattern, text) => {
    // These pass the save-time lint - the deadline is the control.
    expect(validateCadParserTemplate({ version: 1, fields: { address: { pattern } } }).ok).toBe(
      true,
    );
    const started = Date.now();
    const result = await parseCadTextBounded(
      { version: 7, fields: { address: { pattern } } },
      text,
      300,
    );
    expect(result).toEqual({ status: 'RAW', version: 7, reason: 'TIMEOUT', fields: {} });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('no template or empty text answers without a worker', async () => {
    expect(await parseCadTextBounded(undefined, 'x')).toMatchObject({ reason: 'NO_TEMPLATE' });
    expect(await parseCadTextBounded(TEMPLATE, '  ')).toMatchObject({ reason: 'EMPTY' });
  });
});

describe('resolveCadMessageTime (chain review R3-M1)', () => {
  const tz = 'America/New_York';
  // 2026-09-30 23:58 EDT = 2026-10-01 03:58Z
  const nearMidnight = Date.UTC(2026, 9, 1, 3, 58) / 1000;

  it('a bare 2355 then 0003 resolves across midnight: the correction is LATER', () => {
    const original = resolveCadMessageTime('2355', { receivedAt: nearMidnight, timeZone: tz })!;
    const correction = resolveCadMessageTime('0003', {
      receivedAt: nearMidnight + 480,
      timeZone: tz,
    })!;
    expect(new Date(original * 1000).toISOString()).toBe('2026-10-01T03:55:00.000Z');
    expect(correction - original).toBe(8 * 60);
  });

  it('a bare time is placed on the day nearest its OWN receipt, however long the incident (R3b-M1)', () => {
    const at2130 = Date.UTC(2026, 9, 1, 1, 30, 40) / 1000; // 21:30:40 EDT on 30 Sep
    expect(resolveCadMessageTime('2130', { receivedAt: at2130, timeZone: tz })).toBe(
      Date.UTC(2026, 9, 1, 1, 30) / 1000,
    );
    // 2358 received at 00:01 is the previous day; 0002 received at 23:59 the next.
    const at0001 = Date.UTC(2026, 9, 1, 4, 1) / 1000;
    expect(resolveCadMessageTime('2358', { receivedAt: at0001, timeZone: tz })).toBe(
      Date.UTC(2026, 9, 1, 3, 58) / 1000,
    );
    const at2359 = Date.UTC(2026, 9, 1, 3, 59) / 1000;
    expect(resolveCadMessageTime('0002', { receivedAt: at2359, timeZone: tz })).toBe(
      Date.UTC(2026, 9, 1, 4, 2) / 1000,
    );
  });

  it('a wall time repeated at fall-back takes the instant nearest receipt (R3b-M1)', () => {
    // 1 Nov 2026: 01:00-01:59 happens in EDT (05:xxZ) and again in EST (06:xxZ).
    const edt = resolveCadMessageTime('0150', {
      receivedAt: Date.UTC(2026, 10, 1, 5, 50, 20) / 1000,
      timeZone: tz,
    });
    const est = resolveCadMessageTime('0110', {
      receivedAt: Date.UTC(2026, 10, 1, 6, 10, 20) / 1000,
      timeZone: tz,
    });
    expect(edt).toBe(Date.UTC(2026, 10, 1, 5, 50) / 1000);
    expect(est).toBe(Date.UTC(2026, 10, 1, 6, 10) / 1000);
    expect(
      resolveCadMessageTime('11/01/2026 01:10', {
        receivedAt: Date.UTC(2026, 10, 1, 6, 11) / 1000,
        timeZone: tz,
      }),
    ).toBe(Date.UTC(2026, 10, 1, 6, 10) / 1000);
  });

  it('a wall time skipped at spring-forward still resolves (read at the pre-jump offset)', () => {
    // 8 Mar 2026: 02:00 EST jumps to 03:00 EDT; a CAD stamping 0230 is at 07:30Z.
    expect(
      resolveCadMessageTime('0230', {
        receivedAt: Date.UTC(2026, 2, 8, 7, 31) / 1000,
        timeZone: tz,
      }),
    ).toBe(Date.UTC(2026, 2, 8, 7, 30) / 1000);
  });

  it('reads HH:MM and HH:MM:SS, in the department time zone', () => {
    const at = Date.UTC(2026, 8, 30, 16, 0) / 1000; // 12:00 EDT
    expect(resolveCadMessageTime('11:42', { receivedAt: at, timeZone: tz })).toBe(
      Date.UTC(2026, 8, 30, 15, 42) / 1000,
    );
    expect(resolveCadMessageTime('11:42:07', { receivedAt: at, timeZone: tz })).toBe(
      Date.UTC(2026, 8, 30, 15, 42, 7) / 1000,
    );
  });

  it('reads a full date-time within 24 h of receipt, and refuses one outside it', () => {
    const at = Date.UTC(2026, 8, 30, 7, 20) / 1000;
    expect(resolveCadMessageTime('09/30/2026 03:12', { receivedAt: at, timeZone: tz })).toBe(
      Date.UTC(2026, 8, 30, 7, 12) / 1000,
    );
    expect(resolveCadMessageTime('2026-09-30 03:12:30', { receivedAt: at, timeZone: tz })).toBe(
      Date.UTC(2026, 8, 30, 7, 12, 30) / 1000,
    );
    expect(resolveCadMessageTime('09/20/2026 03:12', { receivedAt: at, timeZone: tz })).toBe(
      undefined,
    );
  });

  it.each(['2355Z', 'yesterday', '25:00', '12:61', '', 'TUE 14:02'])(
    '%s is unordered (undefined)',
    (value) => {
      expect(resolveCadMessageTime(value, { receivedAt: nearMidnight, timeZone: tz })).toBe(
        undefined,
      );
    },
  );
});
