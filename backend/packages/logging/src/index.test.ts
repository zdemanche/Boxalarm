import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  extractCorrelationId,
  generateTraceparent,
  parseTraceparent,
  redactPii,
} from './index.js';

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
