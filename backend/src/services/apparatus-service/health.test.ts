import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('health handlers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./apparatusRepository.js');
    vi.restoreAllMocks();
  });

  it('liveness always returns 200', async () => {
    const { livenessHandler } = await import('./health.js');

    const result = await livenessHandler({}, {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('readiness returns 200 when DynamoDB is reachable', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      GSI3_INDEX_NAME: 'GSI3',
      getDocumentClient: () => ({ send: vi.fn().mockResolvedValue({ Items: [] }) }),
      getTableName: () => 'boxalarm-dev-platform',
    }));
    const { readinessHandler } = await import('./health.js');

    const result = await readinessHandler({}, {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('readiness returns 503 when DynamoDB is unreachable', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      GSI3_INDEX_NAME: 'GSI3',
      getDocumentClient: () => ({
        send: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
      }),
      getTableName: () => 'boxalarm-dev-platform',
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { readinessHandler } = await import('./health.js');

    const result = await readinessHandler({}, {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
  });
});
