import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  CertNotFoundError,
  flipEligibilityOnCertExpired,
  memberExists,
  putQual,
  readQuals,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('putQual', () => {
  it('writes the qual item and an OUTBOX row in one TransactWriteItems call (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    const result = await putQual(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      null,
      randomUUID(),
    );
    expect(result).toEqual({
      qualCode: 'INTERIOR',
      grantedByCertId: null,
      currentlyEligible: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] };
    };
    expect(command.input.TransactItems).toHaveLength(2);
    const qualPut = command.input.TransactItems.find(
      (item) => item.Put?.Item.entityType === 'MEMBER_QUALIFICATION',
    );
    expect(qualPut?.Put?.Item.gsi1pk).toBe(`DEPT#${DEPT_ID}#MEMBER#MBR-0012`);
  });

  it('writes the outbox row as entityType OUTBOX_ENTRY with sentAt: null, not the legacy OUTBOX/sent shape (issue #129)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    await putQual(client, TABLE, DEPT_ID, 'MBR-0012', 'INTERIOR', null, randomUUID());
    const command = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] };
    };
    const outboxPut = command.input.TransactItems.find(
      (item) => item.Put?.Item.entityType === 'OUTBOX_ENTRY',
    );
    expect(outboxPut).toBeDefined();
    expect(outboxPut?.Put?.Item.sentAt).toBeNull();
    expect(outboxPut?.Put?.Item.sent).toBeUndefined();
    expect(outboxPut?.Put?.Item.envelope).toBeUndefined();
    expect(outboxPut?.Put?.Item.eventType).toBe('personnel.eligibility.changed');
    expect(outboxPut?.Put?.Item.payload).toMatchObject({ memberId: 'MBR-0012' });
  });

  it('throws and logs the original error, including cancellation reasons, when TransactWriteItems is cancelled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cancellation = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    const send = vi.fn().mockRejectedValue(cancellation);
    const client = fakeClient(send);

    await expect(
      putQual(client, TABLE, DEPT_ID, 'MBR-0012', 'INTERIOR', null, randomUUID()),
    ).rejects.toBe(cancellation);

    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      event: string;
      cancellationReasons: unknown;
    };
    expect(logged.event).toBe('personnel.quals.write.failed');
    expect(logged.cancellationReasons).toEqual([{ Code: 'ConditionalCheckFailed' }]);
  });

  it('reads the linked CERTIFICATION status and writes currentlyEligible=true for a CURRENT cert-backed grant', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { status: 'CURRENT' } })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);
    const result = await putQual(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      'CERT-0091',
      randomUUID(),
    );
    expect(result).toEqual({
      qualCode: 'INTERIOR',
      grantedByCertId: 'CERT-0091',
      currentlyEligible: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('writes currentlyEligible=false for a cert-backed grant whose cert is already EXPIRED (P6, fail-secure)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { status: 'EXPIRED' } })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);
    const result = await putQual(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      'CERT-0091',
      randomUUID(),
    );
    expect(result.currentlyEligible).toBe(false);
  });

  it('throws CertNotFoundError and never writes when grantedByCertId names a cert that does not exist', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const client = fakeClient(send);
    await expect(
      putQual(client, TABLE, DEPT_ID, 'MBR-0012', 'INTERIOR', 'CERT-MISSING', randomUUID()),
    ).rejects.toBeInstanceOf(CertNotFoundError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('flipEligibilityOnCertExpired', () => {
  it('no-ops when no held qual is linked to the expired cert', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = fakeClient(send);
    const flipped = await flipEligibilityOnCertExpired(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'CERT-0091',
      'EXPIRED',
      randomUUID(),
    );
    expect(flipped).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flips currentlyEligible to false and writes an OUTBOX row per qual (AC2)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            qualCode: 'INTERIOR',
            sk: 'QUAL#INTERIOR',
            grantedByCertId: 'CERT-0091',
            currentlyEligible: true,
          },
        ],
      })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);
    const flipped = await flipEligibilityOnCertExpired(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'CERT-0091',
      'EXPIRED',
      randomUUID(),
    );
    expect(flipped).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: false },
    ]);
    const writeCommand = send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } };
    expect(writeCommand.input.TransactItems).toHaveLength(2);
  });

  it('flips currentlyEligible to false when the cert transitioned to REVOKED (P7)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            qualCode: 'INTERIOR',
            sk: 'QUAL#INTERIOR',
            grantedByCertId: 'CERT-0091',
            currentlyEligible: true,
          },
        ],
      })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);
    const flipped = await flipEligibilityOnCertExpired(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'CERT-0091',
      'REVOKED',
      randomUUID(),
    );
    expect(flipped).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: false },
    ]);
  });

  it('scopes the Query to quals granted by the expiring cert only, leaving unrelated held quals out of the flip (P6)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            qualCode: 'INTERIOR',
            sk: 'QUAL#INTERIOR',
            grantedByCertId: 'CERT-0091',
            currentlyEligible: true,
          },
        ],
      })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);
    const flipped = await flipEligibilityOnCertExpired(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'CERT-0091',
      'EXPIRED',
      randomUUID(),
    );
    expect(flipped).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: false },
    ]);
    const queryCommand = send.mock.calls[0]?.[0] as {
      input: { FilterExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(queryCommand.input.FilterExpression).toBe(
      'grantedByCertId = :certId AND currentlyEligible = :eligible',
    );
    expect(queryCommand.input.ExpressionAttributeValues).toMatchObject({
      ':certId': 'CERT-0091',
      ':eligible': true,
    });
    const writeCommand = send.mock.calls[1]?.[0] as {
      input: { TransactItems: { Update?: { ConditionExpression: string } }[] };
    };
    expect(writeCommand.input.TransactItems).toHaveLength(2);
    expect(writeCommand.input.TransactItems[0]?.Update?.ConditionExpression).toBe(
      'grantedByCertId = :certId',
    );
  });

  it('follows LastEvaluatedKey across pages instead of stopping on an empty first page (P8)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: 'p', sk: 's' } })
      .mockResolvedValueOnce({
        Items: [
          {
            qualCode: 'INTERIOR',
            sk: 'QUAL#INTERIOR',
            grantedByCertId: 'CERT-0091',
            currentlyEligible: true,
          },
        ],
      })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);
    const flipped = await flipEligibilityOnCertExpired(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'CERT-0091',
      'EXPIRED',
      randomUUID(),
    );
    expect(flipped).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: 'CERT-0091', currentlyEligible: false },
    ]);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('readQuals', () => {
  it('returns an empty array when the member holds zero quals', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = fakeClient(send);
    const quals = await readQuals(client, TABLE, DEPT_ID, 'MBR-0012');
    expect(quals).toEqual([]);
  });

  it('returns held quals with their currentlyEligible flag', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true }],
    });
    const client = fakeClient(send);
    const quals = await readQuals(client, TABLE, DEPT_ID, 'MBR-0012');
    expect(quals).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true },
    ]);
  });

  it('follows LastEvaluatedKey across pages so held quals are never under-reported (P8)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true }],
        LastEvaluatedKey: { pk: 'p', sk: 's' },
      })
      .mockResolvedValueOnce({
        Items: [{ qualCode: 'DRIVER_OPERATOR', grantedByCertId: null, currentlyEligible: true }],
      });
    const client = fakeClient(send);
    const quals = await readQuals(client, TABLE, DEPT_ID, 'MBR-0012');
    expect(quals).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true },
      { qualCode: 'DRIVER_OPERATOR', grantedByCertId: null, currentlyEligible: true },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('memberExists', () => {
  it('returns false when the MEMBER item is absent', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    expect(await memberExists(client, TABLE, DEPT_ID, 'MBR-9999')).toBe(false);
  });

  it('returns true when the MEMBER item exists', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { pk: 'x', sk: 'METADATA' } });
    const client = fakeClient(send);
    expect(await memberExists(client, TABLE, DEPT_ID, 'MBR-0012')).toBe(true);
  });
});
