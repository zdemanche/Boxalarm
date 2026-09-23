import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, logInfo } from './logger.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BOXALARM_ENV;
  delete process.env.NODE_ENV;
});

describe('logger', () => {
  it('logInfo emits structured JSON with event, correlationId, service, and env', () => {
    process.env.BOXALARM_ENV = 'test';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logInfo('member.created', 'trace-1', { memberId: 'm1' });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'info',
      service: 'personnel-service',
      env: 'test',
      event: 'member.created',
      correlationId: 'trace-1',
      memberId: 'm1',
    });
  });

  it('logError includes the original error message and falls back for non-Error values', () => {
    process.env.BOXALARM_ENV = 'test';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logError('member.create.failed', 'trace-2', new Error('boom'), { memberId: 'm1' });
    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'error',
      service: 'personnel-service',
      env: 'test',
      event: 'member.create.failed',
      correlationId: 'trace-2',
      message: 'boom',
      memberId: 'm1',
    });

    logError('member.create.failed', 'trace-3', 'not-an-error');
    expect(JSON.parse(errorSpy.mock.calls[1]?.[0] as string)).toEqual({
      level: 'error',
      service: 'personnel-service',
      env: 'test',
      event: 'member.create.failed',
      correlationId: 'trace-3',
      message: 'unknown error',
    });
  });

  it('redacts member name/phone/address if callers pass them', () => {
    process.env.BOXALARM_ENV = 'test';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logInfo('member.leaked', 'trace-4', {
      name: 'Jane',
      phone: '203',
      address: '1 Main',
      memberId: 'm1',
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      name: '[REDACTED]',
      phone: '[REDACTED]',
      address: '[REDACTED]',
      memberId: 'm1',
    });
  });
});
