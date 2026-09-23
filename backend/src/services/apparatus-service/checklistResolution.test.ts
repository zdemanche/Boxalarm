import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  resolveApparatusIdByUnitId,
  resolveChecklistTemplateForUnit,
} from './checklistResolution.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeClient(items: readonly Record<string, unknown>[]): DynamoDBDocumentClient {
  return { send: vi.fn().mockResolvedValue({ Items: items }) } as unknown as DynamoDBDocumentClient;
}

describe('resolveApparatusIdByUnitId', () => {
  it('resolves the apparatusId for a unit found on GSI3', async () => {
    const client = fakeClient([
      { pk: 'DEPT#NICHOLS#APPARATUS#APP-ENGINE-2', sk: 'METADATA', unitId: 'ENGINE-2' },
    ]);
    await expect(
      resolveApparatusIdByUnitId(client, 'platform-service', DEPT_ID, 'ENGINE-2'),
    ).resolves.toBe('APP-ENGINE-2');
  });

  it('returns undefined when no apparatus matches the unitId (404 row)', async () => {
    const client = fakeClient([]);
    await expect(
      resolveApparatusIdByUnitId(client, 'platform-service', DEPT_ID, 'UNKNOWN-UNIT'),
    ).resolves.toBeUndefined();
  });

  it('propagates a DynamoDB client failure (fail-closed, becomes a 503 at the handler)', async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB throttled')),
    } as unknown as DynamoDBDocumentClient;
    await expect(
      resolveApparatusIdByUnitId(client, 'platform-service', DEPT_ID, 'ENGINE-2'),
    ).rejects.toThrow('DynamoDB throttled');
  });

  it('scopes the query to the verified department, never a caller-supplied one', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = { send } as unknown as DynamoDBDocumentClient;
    await resolveApparatusIdByUnitId(client, 'platform-service', DEPT_ID, 'ENGINE-2');
    const sentCommand = send.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: unknown };
    };
    expect(sentCommand.input.ExpressionAttributeValues).toMatchObject({
      ':gsi3pk': 'DEPT#NICHOLS#APPARATUS',
      ':gsi3sk': 'ENGINE-2',
    });
  });
});

describe('resolveChecklistTemplateForUnit', () => {
  it('returns the template applying to the given apparatus, requiresPhoto passed through unmodified (AC1/AC3)', async () => {
    const client = fakeClient([
      {
        pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-01',
        sk: 'METADATA',
        name: 'Engine daily check',
        applicableApparatusIds: ['APP-ENGINE-2'],
        items: [
          { code: 'TIRES', label: 'Tire pressure', requiresPhoto: false },
          { code: 'LADDER-MOUNT', label: 'Ladder mount photo', requiresPhoto: true },
        ],
      },
    ]);
    const template = await resolveChecklistTemplateForUnit(
      client,
      'platform-service',
      DEPT_ID,
      'APP-ENGINE-2',
    );
    expect(template).toEqual({
      templateId: 'CT-01',
      name: 'Engine daily check',
      applicableApparatusIds: ['APP-ENGINE-2'],
      items: [
        { code: 'TIRES', label: 'Tire pressure', requiresPhoto: false },
        { code: 'LADDER-MOUNT', label: 'Ladder mount photo', requiresPhoto: true },
      ],
    });
  });

  it('returns undefined when no template applies to the apparatus (404 row)', async () => {
    const client = fakeClient([]);
    await expect(
      resolveChecklistTemplateForUnit(client, 'platform-service', DEPT_ID, 'APP-NOBODY'),
    ).resolves.toBeUndefined();
  });

  it('gives two apparatus of different types their own template, not a shared default (AC2, core-harm)', async () => {
    const engineClient = fakeClient([
      {
        pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-ENGINE',
        sk: 'METADATA',
        name: 'Engine daily check',
        applicableApparatusIds: ['APP-ENGINE-2'],
        items: [{ code: 'TIRES', label: 'Tire pressure', requiresPhoto: false }],
      },
    ]);
    const ladderClient = fakeClient([
      {
        pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-LADDER',
        sk: 'METADATA',
        name: 'Ladder daily check',
        applicableApparatusIds: ['APP-LADDER-1'],
        items: [{ code: 'AERIAL', label: 'Aerial extend/retract', requiresPhoto: true }],
      },
    ]);

    const engineTemplate = await resolveChecklistTemplateForUnit(
      engineClient,
      'platform-service',
      DEPT_ID,
      'APP-ENGINE-2',
    );
    const ladderTemplate = await resolveChecklistTemplateForUnit(
      ladderClient,
      'platform-service',
      DEPT_ID,
      'APP-LADDER-1',
    );

    expect(engineTemplate?.templateId).toBe('CT-ENGINE');
    expect(ladderTemplate?.templateId).toBe('CT-LADDER');
    expect(engineTemplate?.templateId).not.toBe(ladderTemplate?.templateId);
  });

  it('pages the Scan when the match is not on the first page (no silent 404 past 1MB)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: { pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-00', sk: 'METADATA' },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-02',
            sk: 'METADATA',
            name: 'Rescue daily check',
            applicableApparatusIds: ['APP-RESCUE-1'],
            items: [],
          },
        ],
      });
    const client = { send } as unknown as DynamoDBDocumentClient;

    const template = await resolveChecklistTemplateForUnit(
      client,
      'platform-service',
      DEPT_ID,
      'APP-RESCUE-1',
    );

    expect(template?.templateId).toBe('CT-02');
    expect(send).toHaveBeenCalledTimes(2);
    const secondCall = send.mock.calls[1]?.[0] as { input: { ExclusiveStartKey?: unknown } };
    expect(secondCall.input.ExclusiveStartKey).toEqual({
      pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-00',
      sk: 'METADATA',
    });
  });

  it('filters on the verified department and the applicableApparatusIds membership, not a bare templateId lookup', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = { send } as unknown as DynamoDBDocumentClient;
    await resolveChecklistTemplateForUnit(client, 'platform-service', DEPT_ID, 'APP-ENGINE-2');
    const sentCommand = send.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: unknown };
    };
    expect(sentCommand.input.ExpressionAttributeValues).toMatchObject({
      ':pkPrefix': 'DEPT#NICHOLS#CHECKLIST_TEMPLATE',
      ':sk': 'METADATA',
      ':apparatusId': 'APP-ENGINE-2',
    });
  });
});
