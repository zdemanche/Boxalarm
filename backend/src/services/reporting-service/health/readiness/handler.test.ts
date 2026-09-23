import { describe, expect, it, vi } from 'vitest';
import { handler } from './handler.js';

const ENV = { PERSONNEL_TABLE_NAME: 'personnel', PLATFORM_SERVICE_TABLE_NAME: 'platform' };

describe('reporting-service health readiness handler', () => {
  it('returns 200 ready when both the personnel and platform tables describe successfully', async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await handler({} as never, undefined, undefined, ENV, { send } as never);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse(result.body as string)).toEqual({ status: 'ready' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns 503 not-ready when the personnel table DescribeTable fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DescribeTable failed'));
    const result = await handler({} as never, undefined, undefined, ENV, { send } as never);

    expect(result).toMatchObject({ statusCode: 503 });
    expect(JSON.parse(result.body as string)).toEqual({ status: 'not-ready' });
  });

  it('returns 503 not-ready when a required table env var is unset (fail-closed)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await handler(
      {} as never,
      undefined,
      undefined,
      { PERSONNEL_TABLE_NAME: 'personnel' },
      { send } as never,
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('logs the original error before returning 503 (error-path-logging)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('DescribeTable failed'));

    await handler({} as never, undefined, undefined, ENV, { send } as never);

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      originalError?: string;
    };
    expect(logged.originalError).toBe('DescribeTable failed');
    errorSpy.mockRestore();
  });
});
