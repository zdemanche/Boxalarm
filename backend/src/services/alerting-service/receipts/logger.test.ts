import { beforeEach, describe, expect, it, vi } from 'vitest';

const errorSpy = vi.fn();
const infoSpy = vi.fn();

vi.mock('pino', () => ({
  default: Object.assign(
    vi.fn(() => ({ error: errorSpy, info: infoSpy })),
    { stdTimeFunctions: { isoTime: vi.fn() } },
  ),
}));

describe('receipts logger', () => {
  beforeEach(() => {
    errorSpy.mockClear();
    infoSpy.mockClear();
  });

  it('logError delegates to the structured logger at error level, not console.error', async () => {
    const { logError } = await import('./logger.js');
    logError({ event: 'x.failed', reason: 'Error' });
    expect(errorSpy).toHaveBeenCalledWith({ event: 'x.failed', reason: 'Error' });
  });

  it('logInfo delegates to the structured logger at info level, not console.log', async () => {
    const { logInfo } = await import('./logger.js');
    logInfo({ event: 'x.ok' });
    expect(infoSpy).toHaveBeenCalledWith({ event: 'x.ok' });
  });
});
