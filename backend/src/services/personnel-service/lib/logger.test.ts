import { describe, expect, it, vi } from 'vitest';
import { logError, logInfo } from './logger.js';

describe('logger', () => {
  it('logInfo emits structured JSON with event, correlationId, and service', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logInfo('member.created', 'trace-1', { memberId: 'm1' });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'info',
        event: 'member.created',
        correlationId: 'trace-1',
        service: 'personnel-service',
        memberId: 'm1',
      }),
    );
  });

  it('logError includes the original error message and falls back for non-Error values', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logError('member.create.failed', 'trace-2', new Error('boom'), { memberId: 'm1' });
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'error',
        event: 'member.create.failed',
        correlationId: 'trace-2',
        service: 'personnel-service',
        message: 'boom',
        memberId: 'm1',
      }),
    );

    logError('member.create.failed', 'trace-3', 'not-an-error');
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'error',
        event: 'member.create.failed',
        correlationId: 'trace-3',
        service: 'personnel-service',
        message: 'unknown error',
      }),
    );
  });
});
