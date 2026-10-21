import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  resolveApparatusIdByUnitId,
  getChecklistTemplateById,
  resolveApparatusByUnitId,
  resolveDepartmentDefaultTemplate,
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

describe('resolveApparatusByUnitId', () => {
  it("carries the unit's assigned checklistTemplateId when the apparatus row has one", async () => {
    const client = fakeClient([
      {
        pk: 'DEPT#NICHOLS#APPARATUS#APP-ENGINE-2',
        sk: 'METADATA',
        unitId: 'ENGINE-2',
        checklistTemplateId: 'CT-01',
      },
    ]);
    await expect(
      resolveApparatusByUnitId(client, 'platform-service', DEPT_ID, 'ENGINE-2'),
    ).resolves.toEqual({ apparatusId: 'APP-ENGINE-2', checklistTemplateId: 'CT-01' });
  });

  it('omits checklistTemplateId when none is assigned', async () => {
    const client = fakeClient([
      { pk: 'DEPT#NICHOLS#APPARATUS#APP-ENGINE-2', sk: 'METADATA', unitId: 'ENGINE-2' },
    ]);
    await expect(
      resolveApparatusByUnitId(client, 'platform-service', DEPT_ID, 'ENGINE-2'),
    ).resolves.toEqual({ apparatusId: 'APP-ENGINE-2' });
  });
});

describe('getChecklistTemplateById', () => {
  it('reads the template with one keyed GetItem, requiresPhoto passed through unmodified (AC1/AC3)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-01',
        sk: 'METADATA',
        name: 'Engine daily check',
        applicableApparatusIds: ['APP-ENGINE-2'],
        items: [
          { code: 'TIRES', label: 'Tire pressure', requiresPhoto: false },
          { code: 'LADDER-MOUNT', label: 'Ladder mount photo', requiresPhoto: true },
        ],
      },
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    const template = await getChecklistTemplateById(client, 'platform-service', DEPT_ID, 'CT-01');

    expect(template).toEqual({
      templateId: 'CT-01',
      name: 'Engine daily check',
      applicableApparatusIds: ['APP-ENGINE-2'],
      items: [
        { code: 'TIRES', label: 'Tire pressure', requiresPhoto: false, critical: false },
        { code: 'LADDER-MOUNT', label: 'Ladder mount photo', requiresPhoto: true, critical: false },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0] as { input: { Key: unknown } };
    expect(sent.input.Key).toEqual({
      pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-01',
      sk: 'METADATA',
    });
  });

  it('returns undefined when the template does not exist', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    await expect(
      getChecklistTemplateById(client, 'platform-service', DEPT_ID, 'CT-NONE'),
    ).resolves.toBeUndefined();
  });
});

describe('critical items', () => {
  it('passes critical through and reads a record without it as not critical', async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        Item: {
          pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-01',
          sk: 'METADATA',
          name: 'Engine daily check',
          applicableApparatusIds: ['APP-ENGINE-2'],
          items: [
            { code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: true },
            { code: 'LIGHTS', label: 'Lights', requiresPhoto: false },
            { code: 'MIRRORS', label: 'Mirrors', requiresPhoto: false, critical: 'yes' },
          ],
        },
      }),
    } as unknown as DynamoDBDocumentClient;
    const template = await getChecklistTemplateById(client, 'platform-service', DEPT_ID, 'CT-01');
    expect(template?.items.map((item) => [item.code, item.critical])).toEqual([
      ['BRAKES', true],
      ['LIGHTS', false],
      ['MIRRORS', false],
    ]);
  });
});

describe('resolveDepartmentDefaultTemplate', () => {
  it("reads the department's CHECKLIST_DEFAULTS config and versions the templateId", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS',
        sk: 'CONFIG#CHECKLIST_DEFAULTS',
        version: 3,
        value: {
          items: [
            { code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: true },
            { code: 'LIGHTS', label: 'Lights', requiresPhoto: true },
          ],
        },
      },
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    const template = await resolveDepartmentDefaultTemplate(client, 'platform-service', DEPT_ID);

    expect(template).toEqual({
      templateId: 'department-default-v3',
      name: 'Department check sheet',
      applicableApparatusIds: [],
      items: [
        { code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: true },
        { code: 'LIGHTS', label: 'Lights', requiresPhoto: true, critical: false },
      ],
    });
    const sent = send.mock.calls[0]?.[0] as { input: { Key: unknown } };
    expect(sent.input.Key).toEqual({ pk: 'DEPT#NICHOLS', sk: 'CONFIG#CHECKLIST_DEFAULTS' });
  });

  it('returns undefined when the department has no default sheet', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    await expect(
      resolveDepartmentDefaultTemplate(client, 'platform-service', DEPT_ID),
    ).resolves.toBeUndefined();
  });
});
