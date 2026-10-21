import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { parseAuditLogEntryItem } from '../../platform-service/audit/auditEntry.js';
import {
  CertChangedError,
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

const writeCall = (send: { mock: { calls: unknown[][] } }) =>
  send.mock.calls.find(([command]) => !(command instanceof GetCommand))?.[0];

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
      'actor-1',
    );
    expect(result).toEqual({
      qualCode: 'INTERIOR',
      grantedByCertId: null,
      currentlyEligible: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const command = writeCall(send) as {
      input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] };
    };
    expect(command.input.TransactItems).toHaveLength(3);
    const qualPut = command.input.TransactItems.find(
      (item) => item.Put?.Item.entityType === 'MEMBER_QUALIFICATION',
    );
    expect(qualPut?.Put?.Item.gsi1pk).toBe(`DEPT#${DEPT_ID}#MEMBER#MBR-0012`);
  });

  it('writes the outbox row as entityType OUTBOX_ENTRY with sentAt: null, not the legacy OUTBOX/sent shape (issue #129)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    await putQual(client, TABLE, DEPT_ID, 'MBR-0012', 'INTERIOR', null, randomUUID(), 'actor-1');
    const command = writeCall(send) as {
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
    const send = vi.fn((command: unknown) =>
      command instanceof GetCommand ? Promise.resolve({}) : Promise.reject(cancellation),
    );
    const client = fakeClient(send);

    await expect(
      putQual(client, TABLE, DEPT_ID, 'MBR-0012', 'INTERIOR', null, randomUUID(), 'actor-1'),
    ).rejects.toBe(cancellation);

    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      event: string;
      cancellationReasons: unknown;
    };
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(logged.event).toBe('personnel.quals.write.failed');
    expect(logged.cancellationReasons).toEqual([{ Code: 'ConditionalCheckFailed' }]);
  });

  it('reads the linked CERTIFICATION status and writes currentlyEligible=true for a CURRENT cert-backed grant', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
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
      'actor-1',
    );
    expect(result).toEqual({
      qualCode: 'INTERIOR',
      grantedByCertId: 'CERT-0091',
      currentlyEligible: true,
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('writes currentlyEligible=false for a cert-backed grant whose cert is already EXPIRED (P6, fail-secure)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
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
      'actor-1',
    );
    expect(result.currentlyEligible).toBe(false);
  });

  it('throws CertNotFoundError and never writes when grantedByCertId names a cert that does not exist', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    await expect(
      putQual(
        client,
        TABLE,
        DEPT_ID,
        'MBR-0012',
        'INTERIOR',
        'CERT-MISSING',
        randomUUID(),
        'actor-1',
      ),
    ).rejects.toBeInstanceOf(CertNotFoundError);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.some(([command]) => !(command instanceof GetCommand))).toBe(false);
  });
});

describe('putQual against a cert that changes during the write', () => {
  type Item = {
    Put?: { Item: Record<string, unknown> };
    ConditionCheck?: {
      Key: Record<string, string>;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  };
  const itemsOf = (command: unknown) =>
    (command as { input: { TransactItems: Item[] } }).input.TransactItems;
  const cancelled = () =>
    new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [
        { Code: 'None' },
        { Code: 'None' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ],
    });

  it('reads the cert consistently and guards the write with a ConditionCheck on the observed status', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { status: 'CURRENT' } })
      .mockResolvedValueOnce({});
    await putQual(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      'CERT-0091',
      'trace',
      'actor-1',
    );
    expect(
      (send.mock.calls[1]?.[0] as { input: { ConsistentRead?: boolean } }).input.ConsistentRead,
    ).toBe(true);
    const check = itemsOf(send.mock.calls[2]?.[0]).find(
      (item) => item.ConditionCheck,
    )?.ConditionCheck;
    expect(check?.Key).toEqual({ pk: `DEPT#${DEPT_ID}#MEMBER#MBR-0012`, sk: 'CERT#CERT-0091' });
    expect(check?.ConditionExpression).toBe('#status = :observedStatus');
    expect(check?.ExpressionAttributeValues).toEqual({ ':observedStatus': 'CURRENT' });
  });

  it('re-reads after a failed check and stores currentlyEligible=false once the cert is EXPIRED', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { status: 'CURRENT' } })
      .mockRejectedValueOnce(cancelled())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { status: 'EXPIRED' } })
      .mockResolvedValueOnce({});
    const result = await putQual(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      'CERT-0091',
      'trace',
      'actor-1',
    );
    expect(result.currentlyEligible).toBe(false);
    const written = itemsOf(send.mock.calls[5]?.[0]).find(
      (item) => item.Put?.Item.entityType === 'MEMBER_QUALIFICATION',
    );
    expect(written?.Put?.Item.currentlyEligible).toBe(false);
  });

  it('throws CertChangedError when the cert keeps changing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn((command: unknown) =>
      command instanceof GetCommand
        ? Promise.resolve({ Item: { status: 'CURRENT' } })
        : Promise.reject(cancelled()),
    );
    await expect(
      putQual(
        fakeClient(send),
        TABLE,
        DEPT_ID,
        'MBR-0012',
        'INTERIOR',
        'CERT-0091',
        'trace',
        'actor-1',
      ),
    ).rejects.toBeInstanceOf(CertChangedError);
  });

  it('writes an AUDIT_LOG_ENTRY for the grant in the same transaction (F9.4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    await putQual(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      null,
      'trace',
      'actor-1',
    );
    const audit = itemsOf(writeCall(send)).find(
      (item) => item.Put?.Item.entityType === 'AUDIT_LOG_ENTRY',
    );
    expect(audit?.Put?.Item).toMatchObject({
      mutatedEntityType: 'MEMBER_QUALIFICATION',
      mutatedEntityId: 'MBR-0012-INTERIOR',
      actorId: 'actor-1',
      action: 'CREATE',
      changedFields: { currentlyEligible: { old: null, new: true } },
    });
  });

  it('keeps two quals changed in the same millisecond as distinct, queryable audit rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const send = vi.fn().mockResolvedValue({});
      for (const qualCode of ['INTERIOR', 'DRIVER']) {
        await putQual(
          fakeClient(send),
          TABLE,
          DEPT_ID,
          'MBR-0012',
          qualCode,
          null,
          'trace',
          'actor-1',
        );
      }
      const rows = send.mock.calls
        .filter((call) => call[0] instanceof TransactWriteCommand)
        .map(
          (call) =>
            itemsOf(call[0]).find((item) => item.Put?.Item.entityType === 'AUDIT_LOG_ENTRY')?.Put
              ?.Item,
        );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row?.sk)).size).toBe(2);
      expect(rows.map((row) => row?.mutatedEntityId)).toEqual([
        'MBR-0012-INTERIOR',
        'MBR-0012-DRIVER',
      ]);
      const interior = parseAuditLogEntryItem(rows[0] as Record<string, unknown>);
      expect(interior.gsi3pk).toBe(
        buildDeptScopedPk(DEPT_ID, 'AUDIT', 'ENTITY', 'MEMBER_QUALIFICATION', 'MBR-0012-INTERIOR'),
      );
      expect(interior.gsi3sk).toBe('1800000000000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the existing qual as the audit before-image when a grant overwrites it', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: { qualCode: 'INTERIOR', grantedByCertId: 'CERT-A', currentlyEligible: true },
      })
      .mockResolvedValueOnce({});
    await putQual(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      null,
      'trace',
      'actor-1',
    );
    const items = itemsOf(send.mock.calls[1]?.[0]);
    const audit = items.find((item) => item.Put?.Item.entityType === 'AUDIT_LOG_ENTRY');
    expect(audit?.Put?.Item).toMatchObject({
      action: 'UPDATE',
      mutatedEntityId: 'MBR-0012-INTERIOR',
      changedFields: { grantedByCertId: { old: 'CERT-A', new: null } },
    });
    const qual = items.find(
      (item) => item.Put?.Item.entityType === 'MEMBER_QUALIFICATION',
    ) as unknown as {
      Put: { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(qual.Put.ExpressionAttributeValues).toEqual({
      ':prevCert': 'CERT-A',
      ':prevEligible': true,
    });
  });

  it('retries when the qual changed between the read and the write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      )
      .mockResolvedValueOnce({
        Item: { qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true },
      })
      .mockResolvedValueOnce({});
    await putQual(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      null,
      'trace',
      'actor-1',
    );
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('retries a TransactionConflict from a concurrent cert write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'TransactionConflict' },
          ],
        }),
      )
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await putQual(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'INTERIOR',
      null,
      'trace',
      'actor-1',
    );
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does not report a CertChangedError for an audit-key collision on a cert-backed grant', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const collision = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [
        { Code: 'None' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
      ],
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { status: 'CURRENT' } })
      .mockRejectedValueOnce(collision);
    await expect(
      putQual(
        fakeClient(send),
        TABLE,
        DEPT_ID,
        'MBR-0012',
        'INTERIOR',
        'CERT-0091',
        'trace',
        'actor-1',
      ),
    ).rejects.toBe(collision);
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
    expect(
      (send.mock.calls[0]?.[0] as { input: { ConsistentRead?: boolean } }).input.ConsistentRead,
    ).toBe(true);
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
