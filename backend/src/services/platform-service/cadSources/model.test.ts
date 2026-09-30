import { describe, expect, it } from 'vitest';
import {
  isValidSender,
  mergeSources,
  toSourceView,
  validateSourcesInput,
  withWebhookKey,
  type CadSourceInput,
  type StoredCadSource,
} from './model.js';

const INPUT: CadSourceInput = {
  sourceId: 'county',
  label: 'County CAD',
  enabled: true,
  emailEnabled: true,
  allowedSenders: ['cad.county.gov'],
  webhookEnabled: true,
  parserFields: { address: { label: 'ADDR' } },
};

const KEY = {
  keyId: 'nichols-fd.county',
  secretName: 'boxalarm-dev-cad-webhook/nichols-fd/county',
  rotatedAt: '2026-09-30T00:00:00.000Z',
};

describe('validateSourcesInput', () => {
  const valid = {
    sourceId: 'county',
    label: 'County CAD',
    enabled: true,
    emailEnabled: true,
    allowedSenders: ['CAD.County.gov', 'dispatch@cad.county.gov'],
    webhookEnabled: false,
    parser: { fields: { address: { label: 'ADDR' } } },
  };

  it('accepts and normalizes a valid source', () => {
    const result = validateSourcesInput({ sources: [valid] });
    expect(result).toEqual({
      ok: true,
      sources: [
        {
          sourceId: 'county',
          label: 'County CAD',
          enabled: true,
          emailEnabled: true,
          allowedSenders: ['cad.county.gov', 'dispatch@cad.county.gov'],
          webhookEnabled: false,
          parserFields: { address: { label: 'ADDR' } },
        },
      ],
    });
  });

  it.each([
    ['a bad source id', { ...valid, sourceId: 'Bad Id' }],
    ['a duplicate source id', null],
    ['an invalid sender', { ...valid, allowedSenders: ['not a domain'] }],
    ['email with no allowed sender (no accept-anyone mode)', { ...valid, allowedSenders: [] }],
    ['an invalid parser regex', { ...valid, parser: { fields: { address: { pattern: '(' } } } }],
    ['a client-supplied server field', { ...valid, recipientToken: 'x' }],
    ['an invalid time zone', { ...valid, timeZone: 'Mars/Olympus' }],
  ])('rejects %s', (_name, source) => {
    const sources = source === null ? [valid, valid] : [source];
    expect(validateSourcesInput({ sources }).ok).toBe(false);
  });
});

describe('isValidSender', () => {
  it.each(['cad.county.gov', 'dispatch@cad.county.gov'])('accepts %s', (sender) => {
    expect(isValidSender(sender)).toBe(true);
  });
  it.each(['county', '@cad.county.gov', 'a@b', 'cad..gov'])('rejects %s', (sender) => {
    expect(isValidSender(sender)).toBe(false);
  });
});

describe('mergeSources', () => {
  it('generates a recipient token once and keeps it across saves', () => {
    const first = mergeSources([INPUT], [], () => 'token1234567890ab');
    expect(first.sources[0]?.email?.recipientToken).toBe('token1234567890ab');
    const second = mergeSources([INPUT], first.sources, () => 'other');
    expect(second.sources[0]?.email?.recipientToken).toBe('token1234567890ab');
  });

  it('keeps the address token while email is off, and restores it', () => {
    const on = mergeSources([INPUT], [], () => 'token1234567890ab');
    const off = mergeSources([{ ...INPUT, emailEnabled: false }], on.sources, () => 'x');
    expect(off.sources[0]?.email).toBeUndefined();
    const back = mergeSources([INPUT], off.sources, () => 'x');
    expect(back.sources[0]?.email?.recipientToken).toBe('token1234567890ab');
  });

  it('bumps the parser version only when the template changes', () => {
    const v1 = mergeSources([INPUT], []);
    expect(v1.sources[0]?.parser?.version).toBe(1);
    expect(mergeSources([INPUT], v1.sources).sources[0]?.parser?.version).toBe(1);
    const changed = { ...INPUT, parserFields: { address: { label: 'LOCATION' } } };
    expect(mergeSources([changed], v1.sources).sources[0]?.parser?.version).toBe(2);
  });

  it('exposes the webhook to the alerting plane only when enabled AND keyed', () => {
    const unkeyed = mergeSources([INPUT], []);
    expect(unkeyed.sources[0]?.webhook).toBeUndefined();
    const keyed = withWebhookKey(unkeyed.sources, 'county', KEY);
    expect(keyed[0]?.webhook).toEqual({ keyId: KEY.keyId, secretName: KEY.secretName });
    const off = mergeSources([{ ...INPUT, webhookEnabled: false }], keyed);
    expect(off.sources[0]?.webhook).toBeUndefined();
    expect(off.sources[0]?.webhookKey).toEqual(KEY);
  });
});

describe('toSourceView', () => {
  it('shows the address and key id, never the secret name', () => {
    const stored = withWebhookKey(
      mergeSources([INPUT], [], () => 'token1234567890ab').sources,
      'county',
      KEY,
    )[0] as StoredCadSource;
    const view = toSourceView(stored, 'nichols-fd', 'ingress.example.org');
    expect(view.emailAddress).toBe(
      'dispatch+nichols-fd.county.token1234567890ab@ingress.example.org',
    );
    expect(view.webhookKeyId).toBe('nichols-fd.county');
    expect(JSON.stringify(view)).not.toContain('secretName');
    expect(JSON.stringify(view)).not.toContain(KEY.secretName);
  });
});
