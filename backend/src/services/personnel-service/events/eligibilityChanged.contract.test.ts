import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { flipEligibilityOnCertExpired, putQual } from '../quals/repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';

interface CapturedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly source: string;
  readonly correlationId: string;
  readonly schemaVersion: string;
  readonly payload: {
    readonly deptId: string;
    readonly memberId: string;
    readonly qualCode: string;
    readonly currentlyEligible: boolean;
    readonly grantedByCertId: string | null;
  };
}

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function outboxEnvelopeFrom(command: unknown): CapturedEnvelope {
  const input = (
    command as { input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] } }
  ).input;
  const outboxPut = input.TransactItems.find((item) => item.Put?.Item.entityType === 'OUTBOX');
  if (!outboxPut?.Put) {
    throw new Error('no OUTBOX Put found in TransactItems');
  }
  return outboxPut.Put.Item.envelope as CapturedEnvelope;
}

describe('personnel.eligibility.changed contract', () => {
  it('carries the standard envelope and MEMBER_ELIGIBILITY_SNAPSHOT-required payload on a grant (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    await putQual(client, TABLE, DEPT_ID, 'MBR-0012', 'INTERIOR', null, randomUUID());
    const envelope = outboxEnvelopeFrom(send.mock.calls[0]?.[0]);

    expect(envelope.eventType).toBe('personnel.eligibility.changed');
    expect(typeof envelope.eventId).toBe('string');
    expect(typeof envelope.eventTime).toBe('string');
    expect(typeof envelope.source).toBe('string');
    expect(typeof envelope.correlationId).toBe('string');
    expect(typeof envelope.schemaVersion).toBe('string');
    expect(envelope.payload).toEqual({
      deptId: DEPT_ID,
      memberId: 'MBR-0012',
      qualCode: 'INTERIOR',
      currentlyEligible: true,
      grantedByCertId: null,
    });
  });

  it('carries the standard envelope and payload on an eligibility flip (AC2)', async () => {
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
    await flipEligibilityOnCertExpired(
      client,
      TABLE,
      DEPT_ID,
      'MBR-0012',
      'CERT-0091',
      'EXPIRED',
      randomUUID(),
    );
    const envelope = outboxEnvelopeFrom(send.mock.calls[1]?.[0]);

    expect(envelope.eventType).toBe('personnel.eligibility.changed');
    expect(envelope.payload).toEqual({
      deptId: DEPT_ID,
      memberId: 'MBR-0012',
      qualCode: 'INTERIOR',
      currentlyEligible: false,
      grantedByCertId: 'CERT-0091',
    });
  });
});
