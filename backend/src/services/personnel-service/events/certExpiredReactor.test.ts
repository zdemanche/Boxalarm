import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';

const flipEligibilityOnCertExpired = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../awsClients.js', () => ({
  readPersonnelServiceConfig: vi.fn(() => ({
    tableName: 'personnel-table',
    busName: 'platform-bus',
  })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('../quals/repository.js', () => ({
  flipEligibilityOnCertExpired: (...args: unknown[]) => flipEligibilityOnCertExpired(...args),
}));

import { handler } from './certExpiredReactor.js';

function certRecord(
  newStatus: string | undefined,
  oldStatus: string | undefined,
  overrides: Record<string, unknown> = {},
): DynamoDBStreamEvent['Records'][number] {
  const base = {
    pk: 'DEPT#NICHOLS#MEMBER#MBR-0012',
    sk: 'CERT#CERT-0091',
    entityType: 'CERTIFICATION',
    certId: 'CERT-0091',
    ...overrides,
  };
  return {
    eventID: 'rec-1',
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: 'seq-1',
      NewImage: marshall({ ...base, ...(newStatus !== undefined ? { status: newStatus } : {}) }),
      OldImage: marshall({ ...base, ...(oldStatus !== undefined ? { status: oldStatus } : {}) }),
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handler (certExpiredReactor entrypoint)', () => {
  it('flips eligibility when a certification transitions to EXPIRED (AC2)', async () => {
    flipEligibilityOnCertExpired.mockResolvedValue([
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: false },
    ]);

    const result = await handler(
      { Records: [certRecord('EXPIRED', 'CURRENT')] },
      {} as never,
      () => undefined,
    );

    expect(flipEligibilityOnCertExpired).toHaveBeenCalledWith(
      expect.anything(),
      'personnel-table',
      'NICHOLS',
      'MBR-0012',
      'CERT-0091',
      'EXPIRED',
      expect.any(String),
    );
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('flips eligibility when a certification transitions to REVOKED (P7)', async () => {
    flipEligibilityOnCertExpired.mockResolvedValue([
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: false },
    ]);

    const result = await handler(
      { Records: [certRecord('REVOKED', 'CURRENT')] },
      {} as never,
      () => undefined,
    );

    expect(flipEligibilityOnCertExpired).toHaveBeenCalledWith(
      expect.anything(),
      'personnel-table',
      'NICHOLS',
      'MBR-0012',
      'CERT-0091',
      'REVOKED',
      expect.any(String),
    );
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('no-ops when the certification status is not EXPIRED', async () => {
    const result = await handler(
      { Records: [certRecord('CURRENT', 'CURRENT')] },
      {} as never,
      () => undefined,
    );

    expect(flipEligibilityOnCertExpired).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('no-ops when the certification was already EXPIRED (no new transition)', async () => {
    const result = await handler(
      { Records: [certRecord('EXPIRED', 'EXPIRED')] },
      {} as never,
      () => undefined,
    );

    expect(flipEligibilityOnCertExpired).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a malformed record (missing pk) without throwing and without a batch failure', async () => {
    const record = {
      eventID: 'rec-2',
      eventName: 'MODIFY',
      dynamodb: {
        SequenceNumber: 'seq-2',
        NewImage: marshall({ entityType: 'CERTIFICATION', status: 'EXPIRED', certId: 'CERT-0091' }),
      },
    } as never;

    const result = await handler({ Records: [record] }, {} as never, () => undefined);

    expect(flipEligibilityOnCertExpired).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('adds the record to batchItemFailures when the eligibility flip write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    flipEligibilityOnCertExpired.mockRejectedValue(new Error('transact failed'));

    const result = await handler(
      { Records: [certRecord('EXPIRED', 'CURRENT')] },
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('personnel.certExpiredReactor.flipFailed'),
    );
  });
});
