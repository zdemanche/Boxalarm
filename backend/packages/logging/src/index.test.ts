import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  extractCorrelationId,
  extractTraceparent,
  generateTraceparent,
  isPiiKey,
  parseTraceparent,
  redactPii,
} from './index.js';

const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('emits structured JSON with correlationId, service, env, level, and event', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = createLogger({ service: 'inventory-service', env: 'test' });
    logger.info({ event: 'inventory.ok', correlationId: 'cid-1', assetId: 'a1' });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'info',
      service: 'inventory-service',
      env: 'test',
      correlationId: 'cid-1',
      event: 'inventory.ok',
      assetId: 'a1',
    });
  });

  it('routes warn to console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = createLogger({ service: 'inventory-service', env: 'test' });
    logger.warn({ event: 'inventory.slow', correlationId: 'cid-3' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'warn',
      service: 'inventory-service',
      env: 'test',
      correlationId: 'cid-3',
      event: 'inventory.slow',
    });
  });

  describe('env fallback chain', () => {
    const originalBoxalarmEnv = process.env.BOXALARM_ENV;
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (originalBoxalarmEnv === undefined) {
        delete process.env.BOXALARM_ENV;
      } else {
        process.env.BOXALARM_ENV = originalBoxalarmEnv;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('prefers the explicit env option over both env vars', () => {
      process.env.BOXALARM_ENV = 'from-boxalarm-env';
      process.env.NODE_ENV = 'from-node-env';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      createLogger({ service: 'inventory-service', env: 'explicit' }).info({
        event: 'e',
        correlationId: 'c',
      });
      expect((JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { env: string }).env).toBe(
        'explicit',
      );
    });

    it('falls back to BOXALARM_ENV when no explicit env is given', () => {
      process.env.BOXALARM_ENV = 'from-boxalarm-env';
      process.env.NODE_ENV = 'from-node-env';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      createLogger({ service: 'inventory-service' }).info({ event: 'e', correlationId: 'c' });
      expect((JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { env: string }).env).toBe(
        'from-boxalarm-env',
      );
    });

    it('falls back to NODE_ENV when BOXALARM_ENV is unset', () => {
      delete process.env.BOXALARM_ENV;
      process.env.NODE_ENV = 'from-node-env';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      createLogger({ service: 'inventory-service' }).info({ event: 'e', correlationId: 'c' });
      expect((JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { env: string }).env).toBe(
        'from-node-env',
      );
    });

    it('falls back to "dev" when neither env var is set', () => {
      delete process.env.BOXALARM_ENV;
      delete process.env.NODE_ENV;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      createLogger({ service: 'inventory-service' }).info({ event: 'e', correlationId: 'c' });
      expect((JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { env: string }).env).toBe('dev');
    });
  });

  it('routes error to console.error and redacts PII keys in fields', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger({ service: 'personnel-service', env: 'dev' });
    logger.error({
      event: 'member.failed',
      correlationId: 'cid-2',
      name: 'Jane Doe',
      phone: '+15551212',
      memberId: 'm1',
    });
    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'error',
      service: 'personnel-service',
      env: 'dev',
      correlationId: 'cid-2',
      event: 'member.failed',
      name: '[REDACTED]',
      phone: '[REDACTED]',
      memberId: 'm1',
    });
  });
});

describe('isPiiKey', () => {
  it('matches known PII key names case-insensitively', () => {
    expect(isPiiKey('phoneNumber')).toBe(true);
    expect(isPiiKey('PhoneNumber')).toBe(true);
    expect(isPiiKey('EMAIL')).toBe(true);
  });

  it('matches a dotted suffix (nested field path)', () => {
    expect(isPiiKey('member.phoneNumber')).toBe(true);
    expect(isPiiKey('member.address')).toBe(true);
  });

  it('does not match unrelated key names', () => {
    expect(isPiiKey('memberId')).toBe(false);
    expect(isPiiKey('assetId')).toBe(false);
    expect(isPiiKey('status')).toBe(false);
  });
});

describe('redactPii', () => {
  it('redacts phone, email, name, and address keys nested in objects', () => {
    expect(
      redactPii({
        memberId: 'm1',
        phoneNumber: '203-555-0100',
        email: 'a@b.co',
        firstName: 'Pat',
        address: '1 Main St',
        nested: { streetAddress: '2 Oak Ave', zipCode: '06611', ok: true },
      }),
    ).toEqual({
      memberId: 'm1',
      phoneNumber: '[REDACTED]',
      email: '[REDACTED]',
      firstName: '[REDACTED]',
      address: '[REDACTED]',
      nested: { streetAddress: '[REDACTED]', zipCode: '[REDACTED]', ok: true },
    });
  });
});

describe('traceparent', () => {
  it('parses a valid W3C traceparent and rejects all-zero ids', () => {
    const parsed = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(parsed).toEqual({
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      flags: '01',
    });
    expect(
      parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    ).toBeUndefined();
    expect(parseTraceparent('not-a-traceparent')).toBeUndefined();
  });

  it('extractCorrelationId prefers traceparent trace-id over x-correlation-id', () => {
    const id = extractCorrelationId({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-correlation-id': 'legacy-id',
    });
    expect(id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('extractCorrelationId falls back to x-correlation-id then generates a uuid', () => {
    expect(extractCorrelationId({ 'X-Correlation-Id': 'from-header' })).toBe('from-header');
    expect(extractCorrelationId({})).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
    );
  });

  it('generateTraceparent produces a parseable header', () => {
    const header = generateTraceparent('4bf92f3577b34da6a3ce929d0e0e4736');
    const parsed = parseTraceparent(header);
    expect(parsed?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(parsed?.version).toBe('00');
    expect(parsed?.flags).toBe('01');
  });
});

describe('extractTraceparent', () => {
  it('propagates a valid incoming traceparent header, forcing version 00', () => {
    const result = extractTraceparent({
      traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('generates a fresh valid traceparent for a root span when no header is present', () => {
    // This is the normal case for the first hop of a request: no throw, a brand-new
    // valid W3C traceparent comes back instead.
    const result = extractTraceparent(undefined);
    expect(result).toMatch(TRACEPARENT_RE);
    expect(parseTraceparent(result)).toBeDefined();
  });

  it('generates a fresh valid traceparent when headers are present but carry no traceparent', () => {
    const result = extractTraceparent({ 'x-correlation-id': 'some-other-id' });
    expect(result).toMatch(TRACEPARENT_RE);
  });

  it('generates a fresh valid traceparent (does not throw) when the incoming header is malformed', () => {
    expect(() => extractTraceparent({ traceparent: 'not-a-traceparent' })).not.toThrow();
    const result = extractTraceparent({ traceparent: 'not-a-traceparent' });
    expect(result).toMatch(TRACEPARENT_RE);
  });

  it('generates a fresh valid traceparent when the incoming header has an all-zero trace-id', () => {
    const result = extractTraceparent({
      traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    });
    expect(result).toMatch(TRACEPARENT_RE);
  });

  it('produces a different trace-id on each call when generating fresh (root-span isolation)', () => {
    const a = extractTraceparent(undefined);
    const b = extractTraceparent(undefined);
    expect(a).not.toBe(b);
  });
});
