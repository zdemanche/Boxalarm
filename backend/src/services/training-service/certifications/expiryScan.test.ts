import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const loggedErrors = vi.fn();
vi.mock('../logger.js', () => ({ logError: loggedErrors, logInfo: vi.fn() }));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  loggedErrors.mockClear();
  process.env.DEPT_ID = 'NICHOLS';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('expiryScan handler (entrypoint)', () => {
  it('flips 0 certs and emits a 0 metric when no certs are due (empty input)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const { createDynamoClient } = await import('../dynamoClient.js');
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./expiryScan.js');

    const result = await handler();

    expect(result).toEqual({ scanned: 0, flipped: 0 });
    const metricLog = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.CertificationsExpired !== undefined);
    expect(metricLog?.CertificationsExpired).toBe(0);
    logSpy.mockRestore();
  });

  it('flips every due CURRENT cert past expiry and skips an already-REVOKED cert (AC1)', async () => {
    let queryCalls = 0;
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'QueryCommand') {
        queryCalls += 1;
        if (queryCalls > 1) {
          return Promise.resolve({ Items: [] });
        }
        return Promise.resolve({
          Items: [
            {
              certId: 'CERT-0091',
              memberId: 'MBR-0034',
              expiryDate: '2026-01-01',
              status: 'CURRENT',
            },
            {
              certId: 'CERT-0099',
              memberId: 'MBR-0035',
              expiryDate: '2026-01-01',
              status: 'REVOKED',
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { createDynamoClient } = await import('../dynamoClient.js');
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    const { handler } = await import('./expiryScan.js');

    const result = await handler();

    expect(result.scanned).toBe(2);
    expect(result.flipped).toBe(1);
    const transactCommands = send.mock.calls.filter(
      (call) =>
        (call[0] as { constructor: { name: string } }).constructor.name === 'TransactWriteCommand',
    );
    expect(transactCommands).toHaveLength(1);
    vi.useRealTimers();
  });

  it('rethrows without flipping anything when the GSI2 query fails (fail-closed, unavailable-dependency)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./expiryScan.js');

    await expect(handler()).rejects.toThrow('DynamoDB unavailable');

    expect(loggedErrors).toHaveBeenCalled();
    const logged = loggedErrors.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('training.expiryScan.queryFailed');
  });

  it('throws a descriptive error when DEPT_ID is not set', async () => {
    delete process.env.DEPT_ID;
    const { handler } = await import('./expiryScan.js');

    await expect(handler()).rejects.toThrow('DEPT_ID is required and was not set');
  });

  it('logs and skips a single flip failure without stopping the batch, returning an accurate count (A15/R4)', async () => {
    let queryCalls = 0;
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'QueryCommand') {
        queryCalls += 1;
        if (queryCalls > 1) {
          return Promise.resolve({ Items: [] });
        }
        return Promise.resolve({
          Items: [
            {
              certId: 'CERT-BAD',
              memberId: 'MBR-0001',
              expiryDate: '2026-01-01',
              status: 'CURRENT',
            },
            {
              certId: 'CERT-GOOD',
              memberId: 'MBR-0002',
              expiryDate: '2026-01-01',
              status: 'CURRENT',
            },
          ],
        });
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const key = (
          command as unknown as {
            input: { TransactItems: Array<{ Update?: { Key: { sk: string } } }> };
          }
        ).input.TransactItems[0]?.Update?.Key.sk;
        if (key === 'CERT#CERT-BAD') {
          return Promise.reject(new Error('DynamoDB unavailable'));
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { createDynamoClient } = await import('../dynamoClient.js');
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    const { handler } = await import('./expiryScan.js');

    const result = await handler();

    expect(result).toEqual({ scanned: 2, flipped: 1 });
    const flipFailedLog = loggedErrors.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((entry) => entry.event === 'training.expiryScan.flipFailed');
    expect(flipFailedLog?.certId).toBe('CERT-BAD');
    vi.useRealTimers();
  });
});
