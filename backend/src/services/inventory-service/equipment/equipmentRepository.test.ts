import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createEquipmentAsset,
  getEquipmentAsset,
  listEquipmentAssets,
  setAssignment,
  setLocation,
} from './equipmentRepository.js';

const TABLE = 'boxalarm-platform';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const ACTOR_ID = 'MBR-1';

function fakeDocClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBDocumentClient;
}

describe('createEquipmentAsset', () => {
  it('AC1: writes a pk built only via buildDeptScopedPk, unassigned by default (core-harm)', async () => {
    let putInput: PutCommand['input'] | undefined;
    const client = fakeDocClient((command) => {
      if (command instanceof PutCommand) {
        putInput ??= command.input;
        return {};
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const asset = await createEquipmentAsset(client, TABLE, DEPT_ID, ACTOR_ID, {
      serialNumber: 'SN-100',
      location: 'Station 1',
    });

    expect(putInput?.Item?.pk).toMatch(/^DEPT#NICHOLS#ASSET#/);
    expect(putInput?.Item?.sk).toBe('METADATA');
    expect(putInput?.Item?.assignedToType).toBeUndefined();
    expect(putInput?.Item?.assignedToId).toBeUndefined();
    expect(asset.assignedToType).toBeUndefined();
    expect(asset.serialNumber).toBe('SN-100');
    expect(asset.lifecycleStatus).toBe('ACQUIRED');
  });

  it('writes an AUDIT_LOG_ENTRY alongside the asset (F9.4)', async () => {
    const puts: PutCommand['input'][] = [];
    const client = fakeDocClient((command) => {
      if (command instanceof PutCommand) {
        puts.push(command.input);
        return {};
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    await createEquipmentAsset(client, TABLE, DEPT_ID, ACTOR_ID, {
      serialNumber: 'SN-100',
      location: 'Station 1',
    });

    expect(puts).toHaveLength(2);
    const auditItem = puts[1]?.Item;
    expect(auditItem?.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(auditItem?.pk).toMatch(/^DEPT#NICHOLS#AUDIT#\d{4}-\d{2}-\d{2}$/);
    expect(auditItem?.mutatedEntityType).toBe('EQUIPMENT_ASSET');
    expect(auditItem?.action).toBe('CREATE');
    expect(auditItem?.actorId).toBe(ACTOR_ID);
  });
});

describe('getEquipmentAsset', () => {
  it('returns undefined when the item is absent', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(GetCommand);
      return { Item: undefined };
    });
    expect(await getEquipmentAsset(client, TABLE, DEPT_ID, 'AS-1')).toBeUndefined();
  });

  it('AC2: returns assignedToType/assignedToId when the stored item carries them', async () => {
    const client = fakeDocClient(() => ({
      Item: {
        assetId: 'AS-1',
        deptId: 'NICHOLS',
        serialNumber: 'SN-1',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-1',
        location: 'Station 1',
        lifecycleStatus: 'IN_SERVICE',
      },
    }));
    const asset = await getEquipmentAsset(client, TABLE, DEPT_ID, 'AS-1');
    expect(asset).toEqual({
      assetId: 'AS-1',
      deptId: 'NICHOLS',
      serialNumber: 'SN-1',
      assignedToType: 'MEMBER',
      assignedToId: 'MBR-1',
      location: 'Station 1',
      lifecycleStatus: 'IN_SERVICE',
    });
  });
});

describe('listEquipmentAssets', () => {
  it('AC1: dept-wide list queries gsi3 on the dept partition, no Scan', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      const input = (command as QueryCommand).input;
      expect(input.IndexName).toBe('GSI3');
      expect(input.ExpressionAttributeValues?.[':gsi3Pk']).toBe('DEPT#NICHOLS#EQUIPMENT_ASSET');
      return { Items: [] };
    });
    await listEquipmentAssets(client, TABLE, DEPT_ID);
  });

  it('AC2: member-assigned list queries gsi1 by MEMBER#{id}, scoped to the caller department', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      const input = (command as QueryCommand).input;
      expect(input.IndexName).toBe('GSI1');
      expect(input.ExpressionAttributeValues?.[':gsi1Pk']).toBe('MEMBER#MBR-1');
      expect(input.FilterExpression).toBe('deptId = :deptId');
      expect(input.ExpressionAttributeValues?.[':deptId']).toBe('NICHOLS');
      return { Items: [] };
    });
    await listEquipmentAssets(client, TABLE, DEPT_ID, {
      assignedToType: 'MEMBER',
      assignedToId: 'MBR-1',
    });
  });

  it('CRITICAL P1/P7: excludes a foreign-department item returned on the gsi1 MEMBER partition (cross-tenant leak)', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {
        Items: [
          {
            assetId: 'AS-mine',
            deptId: 'NICHOLS',
            serialNumber: 'SN-mine',
            location: 'x',
            lifecycleStatus: 'ACQUIRED',
          },
          {
            assetId: 'AS-foreign',
            deptId: 'OTHER-DEPT',
            serialNumber: 'SN-foreign',
            location: 'y',
            lifecycleStatus: 'ACQUIRED',
          },
        ],
      };
    });
    const items = await listEquipmentAssets(client, TABLE, DEPT_ID, {
      assignedToType: 'MEMBER',
      assignedToId: 'MBR-1',
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.assetId).toBe('AS-mine');
  });

  it('AC2: apparatus-filtered list queries gsi3 with a FilterExpression on assignedToType/Id', async () => {
    const client = fakeDocClient((command) => {
      const input = (command as QueryCommand).input;
      expect(input.IndexName).toBe('GSI3');
      expect(input.FilterExpression).toBe('assignedToType = :type AND assignedToId = :id');
      expect(input.ExpressionAttributeValues).toMatchObject({
        ':type': 'APPARATUS',
        ':id': 'APP-1',
      });
      return { Items: [] };
    });
    await listEquipmentAssets(client, TABLE, DEPT_ID, {
      assignedToType: 'APPARATUS',
      assignedToId: 'APP-1',
    });
  });

  it('P3/P10: pages through LastEvaluatedKey rather than truncating the department registry', async () => {
    let calls = 0;
    const client = fakeDocClient((command) => {
      const input = (command as QueryCommand).input;
      calls += 1;
      if (calls === 1) {
        expect(input.ExclusiveStartKey).toBeUndefined();
        return {
          Items: [
            {
              assetId: 'AS-1',
              deptId: 'NICHOLS',
              serialNumber: 'SN-1',
              location: 'x',
              lifecycleStatus: 'ACQUIRED',
            },
          ],
          LastEvaluatedKey: { pk: 'DEPT#NICHOLS#EQUIPMENT_ASSET', sk: 'AS-1' },
        };
      }
      expect(input.ExclusiveStartKey).toEqual({ pk: 'DEPT#NICHOLS#EQUIPMENT_ASSET', sk: 'AS-1' });
      return {
        Items: [
          {
            assetId: 'AS-2',
            deptId: 'NICHOLS',
            serialNumber: 'SN-2',
            location: 'y',
            lifecycleStatus: 'ACQUIRED',
          },
        ],
      };
    });
    const items = await listEquipmentAssets(client, TABLE, DEPT_ID);
    expect(calls).toBe(2);
    expect(items.map((item) => item.assetId)).toEqual(['AS-1', 'AS-2']);
  });
});

describe('setAssignment', () => {
  it('AC2: assigning to a member sets gsi1pk/gsi1sk and writes an audit entry', async () => {
    const commands: unknown[] = [];
    const client = fakeDocClient((command) => {
      commands.push(command);
      if (command instanceof UpdateCommand) {
        expect(command.input.UpdateExpression).toContain('gsi1pk = :gsi1pk');
        return {
          Attributes: {
            assetId: 'AS-1',
            deptId: 'NICHOLS',
            serialNumber: 'SN-1',
            assignedToType: 'MEMBER',
            assignedToId: 'MBR-1',
            location: 'Station 1',
            lifecycleStatus: 'ACQUIRED',
          },
        };
      }
      return {};
    });
    const asset = await setAssignment(client, TABLE, DEPT_ID, ACTOR_ID, 'AS-1', 'MEMBER', 'MBR-1');
    expect(asset?.assignedToType).toBe('MEMBER');
    expect(asset?.assignedToId).toBe('MBR-1');
    expect(commands.filter((c) => c instanceof PutCommand)).toHaveLength(1);
  });

  it('AC2: reassigning to an apparatus removes gsi1pk/gsi1sk so no stale member row survives', async () => {
    const client = fakeDocClient((command) => {
      if (command instanceof UpdateCommand) {
        expect(command.input.UpdateExpression).toContain('REMOVE gsi1pk, gsi1sk');
        return {
          Attributes: {
            assetId: 'AS-1',
            deptId: 'NICHOLS',
            serialNumber: 'SN-1',
            location: 'x',
            lifecycleStatus: 'ACQUIRED',
          },
        };
      }
      return {};
    });
    await setAssignment(client, TABLE, DEPT_ID, ACTOR_ID, 'AS-1', 'APPARATUS', 'APP-1');
  });

  it('returns undefined when the asset does not exist (404 path) and writes no audit entry', async () => {
    const commands: unknown[] = [];
    const client = fakeDocClient((command) => {
      commands.push(command);
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });
    expect(
      await setAssignment(client, TABLE, DEPT_ID, ACTOR_ID, 'missing', 'MEMBER', 'MBR-1'),
    ).toBeUndefined();
    expect(commands).toHaveLength(1);
  });
});

describe('setLocation', () => {
  it('AC3/CRITICAL P6: aliases the reserved word "location" and updates only location', async () => {
    const client = fakeDocClient((command) => {
      if (command instanceof UpdateCommand) {
        expect(command.input.UpdateExpression).toBe('SET #location = :location');
        expect(command.input.ExpressionAttributeNames).toEqual({ '#location': 'location' });
        expect(Object.keys(command.input.ExpressionAttributeValues ?? {})).toEqual([':location']);
        return {
          Attributes: {
            assetId: 'AS-1',
            deptId: 'NICHOLS',
            serialNumber: 'SN-1',
            assignedToType: 'MEMBER',
            assignedToId: 'MBR-1',
            location: 'Station 2',
            lifecycleStatus: 'ACQUIRED',
          },
        };
      }
      return {};
    });
    const asset = await setLocation(client, TABLE, DEPT_ID, ACTOR_ID, 'AS-1', 'Station 2');
    expect(asset?.location).toBe('Station 2');
    expect(asset?.assignedToType).toBe('MEMBER');
    expect(asset?.assignedToId).toBe('MBR-1');
  });

  it('returns undefined when the asset does not exist (404 path)', async () => {
    const client = fakeDocClient(() => {
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });
    expect(
      await setLocation(client, TABLE, DEPT_ID, ACTOR_ID, 'missing', 'Station 2'),
    ).toBeUndefined();
  });
});
