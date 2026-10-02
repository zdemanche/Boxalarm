import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  SecondaryConflictError,
  getIncidentSecondary,
  putIncidentSecondary,
  queryIncidentSecondaries,
} from './secondaryRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';
const TRACE_ID = 'trace-abc-123';
const WRITE = { previous: undefined, actorId: 'MBR-0001' };

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('secondaryRepository', () => {
  it('writes an INCIDENT_SECONDARY item keyed by secondaryType with affected members (E6-S6 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});

    await putIncidentSecondary(
      fakeClient(send),
      TABLE_NAME,
      DEPT_ID,
      {
        incidentId: 'NICHOLS-4471-1798000000',
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
        updatedAt: 1,
      },
      TRACE_ID,
      WRITE,
    );

    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> } },
    ];
    expect(command.input.TransactItems[0]?.Put.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
      sk: 'SECONDARY#EXPOSURE',
      entityType: 'INCIDENT_SECONDARY',
      secondaryType: 'EXPOSURE',
      affectedMemberIds: ['MBR-0034'],
    });
  });

  it('writes an incident.secondary.updated OUTBOX_ENTRY in the same transaction', async () => {
    const send = vi.fn().mockResolvedValue({});

    await putIncidentSecondary(
      fakeClient(send),
      TABLE_NAME,
      DEPT_ID,
      {
        incidentId: 'NICHOLS-4471-1798000000',
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
        updatedAt: 1,
      },
      TRACE_ID,
      WRITE,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> } },
    ];
    expect(command.input.TransactItems[1]?.Put.Item).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'incident.secondary.updated',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: {
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        secondaryType: 'EXPOSURE',
        affectedMemberIds: ['MBR-0034'],
      },
    });
  });

  it('refuses a secondaryType or incidentId containing the key delimiter without writing', async () => {
    const send = vi.fn().mockResolvedValue({});
    const base = {
      incidentId: 'NICHOLS-4471-1798000000',
      secondaryType: 'EXPOSURE',
      payload: {},
      affectedMemberIds: [],
      updatedAt: 1,
    };

    await expect(
      putIncidentSecondary(
        fakeClient(send),
        TABLE_NAME,
        DEPT_ID,
        { ...base, secondaryType: 'EXPOSURE#X' },
        TRACE_ID,
        WRITE,
      ),
    ).rejects.toThrow(/secondaryType/);
    await expect(
      putIncidentSecondary(
        fakeClient(send),
        TABLE_NAME,
        DEPT_ID,
        { ...base, incidentId: 'A#B' },
        TRACE_ID,
        WRITE,
      ),
    ).rejects.toThrow(/incidentId/);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns each Secondary module as its own distinct item (E6-S6 AC3)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { sk: 'SECONDARY#EXPOSURE', secondaryType: 'EXPOSURE' },
        { sk: 'SECONDARY#RESPONDER_SAFETY', secondaryType: 'RESPONDER_SAFETY' },
      ],
    });

    const results = await queryIncidentSecondaries(
      fakeClient(send),
      TABLE_NAME,
      DEPT_ID,
      'NICHOLS-4471-1798000000',
    );

    expect(results.map((item) => item.secondaryType)).toEqual(['EXPOSURE', 'RESPONDER_SAFETY']);
  });

  // Review M3: writes were an unconditional overwrite with no audit row.
  describe('concurrency and audit (M3)', () => {
    const NEXT = {
      incidentId: 'NICHOLS-4471-1798000000',
      secondaryType: 'EXPOSURE',
      payload: { exposure_type: 'SMOKE' },
      affectedMemberIds: ['MBR-0034'],
      updatedAt: 20,
    };

    function sentItems(send: ReturnType<typeof vi.fn>) {
      const [command] = send.mock.calls[0] as [
        { input: { TransactItems: Array<Record<string, Record<string, unknown>>> } },
      ];
      return command.input.TransactItems;
    }

    it('creates only when no module exists, at version 1', async () => {
      const send = vi.fn().mockResolvedValue({});

      const version = await putIncidentSecondary(
        fakeClient(send),
        TABLE_NAME,
        DEPT_ID,
        NEXT,
        TRACE_ID,
        WRITE,
      );

      expect(version).toBe(1);
      expect(sentItems(send)[0]?.Put).toMatchObject({
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: { version: 1, updatedBy: 'MBR-0001' },
      });
    });

    it('updates only the version it read, and bumps it', async () => {
      const send = vi.fn().mockResolvedValue({});
      const previous = { ...NEXT, affectedMemberIds: ['MBR-0034', 'MBR-0040'], version: 4 };

      const version = await putIncidentSecondary(
        fakeClient(send),
        TABLE_NAME,
        DEPT_ID,
        NEXT,
        TRACE_ID,
        { previous, actorId: 'MBR-0001' },
      );

      expect(version).toBe(5);
      expect(sentItems(send)[0]?.Put).toMatchObject({
        ConditionExpression: '#version = :previousVersion',
        ExpressionAttributeValues: { ':previousVersion': 4 },
      });
    });

    it('guards a pre-version row on the updatedAt it read', async () => {
      const send = vi.fn().mockResolvedValue({});

      await putIncidentSecondary(fakeClient(send), TABLE_NAME, DEPT_ID, NEXT, TRACE_ID, {
        previous: { ...NEXT, updatedAt: 7 },
        actorId: 'MBR-0001',
      });

      expect(sentItems(send)[0]?.Put).toMatchObject({
        ConditionExpression: 'attribute_not_exists(#version) AND updatedAt = :previousUpdatedAt',
        ExpressionAttributeValues: { ':previousUpdatedAt': 7 },
      });
    });

    it('writes a create-once audit row with the old and new payload and members', async () => {
      const send = vi.fn().mockResolvedValue({});
      const previous = {
        ...NEXT,
        payload: { exposure_type: 'ASBESTOS' },
        affectedMemberIds: ['MBR-0034', 'MBR-0040'],
        version: 2,
      };

      await putIncidentSecondary(fakeClient(send), TABLE_NAME, DEPT_ID, NEXT, TRACE_ID, {
        previous,
        actorId: 'MBR-0001',
      });

      const audit = sentItems(send)[3]?.Put;
      expect(audit).toMatchObject({
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: {
          entityType: 'AUDIT_LOG_ENTRY',
          mutatedEntityType: 'INCIDENT',
          mutatedEntityId: 'NICHOLS-4471-1798000000',
          action: 'UPDATE_SECONDARY',
          actorId: 'MBR-0001',
          secondaryType: 'EXPOSURE',
          changedFields: {
            payload: { old: { exposure_type: 'ASBESTOS' }, new: { exposure_type: 'SMOKE' } },
            affectedMemberIds: { old: ['MBR-0034', 'MBR-0040'], new: ['MBR-0034'] },
          },
        },
      });
      expect(String((audit?.Item as { pk: string }).pk)).toMatch(/^DEPT#NICHOLS#AUDIT#/);
    });

    it('turns a failed version condition into SecondaryConflictError', async () => {
      const send = vi.fn().mockRejectedValue(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      );

      await expect(
        putIncidentSecondary(fakeClient(send), TABLE_NAME, DEPT_ID, NEXT, TRACE_ID, WRITE),
      ).rejects.toBeInstanceOf(SecondaryConflictError);
    });

    it('reads the current module with a consistent read', async () => {
      const send = vi.fn().mockResolvedValue({ Item: { ...NEXT, version: 3 } });

      await expect(
        getIncidentSecondary(fakeClient(send), TABLE_NAME, DEPT_ID, NEXT.incidentId, 'EXPOSURE'),
      ).resolves.toMatchObject({ version: 3 });
      const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
      expect(command.input).toMatchObject({
        Key: { pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000', sk: 'SECONDARY#EXPOSURE' },
        ConsistentRead: true,
      });
    });
  });
});
