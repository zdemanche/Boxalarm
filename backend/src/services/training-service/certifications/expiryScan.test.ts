import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

const loggedErrors = vi.fn();
vi.mock('../logger.js', () => ({ logError: loggedErrors, logInfo: vi.fn() }));

const originalEnv = { ...process.env };
const DEPT_ID = 'NICHOLS' as VerifiedDeptId;
const NOW = new Date('2026-09-14T12:00:00Z');

beforeEach(() => {
  vi.resetModules();
  loggedErrors.mockClear();
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function transactSk(command: unknown): string | undefined {
  return (command as { input: { TransactItems: Array<{ Update?: { Key: { sk: string } } }> } })
    .input.TransactItems[0]?.Update?.Key.sk;
}

describe('flipExpiredCertifications', () => {
  it('flips a CURRENT cert past expiry, skips an already-REVOKED cert, and emits the metric (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { flipExpiredCertifications } = await import('./expiryScan.js');

    const result = await flipExpiredCertifications(
      { send } as unknown as DynamoDBDocumentClient,
      process.env,
      DEPT_ID,
      [
        { certId: 'CERT-0091', memberId: 'MBR-0034', expiryDate: '2026-01-01', status: 'CURRENT' },
        { certId: 'CERT-0099', memberId: 'MBR-0035', expiryDate: '2026-01-01', status: 'REVOKED' },
      ],
      NOW,
    );

    expect(result).toEqual({ flipped: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const metricLog = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.CertificationsExpired !== undefined);
    expect(metricLog?.CertificationsExpired).toBe(1);
    logSpy.mockRestore();
  });

  it('logs and skips a single flip failure without stopping the batch, returning an accurate count (A15/R4)', async () => {
    const send = vi
      .fn()
      .mockImplementation((command: unknown) =>
        transactSk(command) === 'CERT#CERT-BAD'
          ? Promise.reject(new Error('DynamoDB unavailable'))
          : Promise.resolve({}),
      );
    const { flipExpiredCertifications } = await import('./expiryScan.js');

    const result = await flipExpiredCertifications(
      { send } as unknown as DynamoDBDocumentClient,
      process.env,
      DEPT_ID,
      [
        { certId: 'CERT-BAD', memberId: 'MBR-0001', expiryDate: '2026-01-01', status: 'CURRENT' },
        { certId: 'CERT-GOOD', memberId: 'MBR-0002', expiryDate: '2026-01-01', status: 'CURRENT' },
      ],
      NOW,
    );

    expect(result).toEqual({ flipped: 1, failed: 1 });
    const flipFailedLog = loggedErrors.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((entry) => entry.event === 'training.expiryScan.flipFailed');
    expect(flipFailedLog?.certId).toBe('CERT-BAD');
  });
});
