import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DuplicateIncidentError,
  InvalidIncidentStatusError,
  createIncidentRepository,
  getDocumentClient,
  getTableName,
} from './repository.js';
import { buildNerisIncidentId, INCIDENT_STATUSES } from './entity.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

const BASE_INPUT = {
  dispatchNumber: '4471',
  epochSeconds: 1_798_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: { incident_type: 'STRUCTURE_FIRE', opaque: true },
  createdBy: 'MBR-0034',
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  alarmAt: 1_798_000_000,
} as const;

describe('buildNerisIncidentId', () => {
  it('composes incidentId as deptId-dispatchNumber-epochSeconds (same as dispatchId)', () => {
    expect(buildNerisIncidentId('NICHOLS', '4471', 1_798_000_000)).toBe('NICHOLS-4471-1798000000');
  });
});

describe('INCIDENT_STATUSES', () => {
  it('accepts only DRAFT, VALIDATED, SUBMITTED, ACCEPTED, REJECTED', () => {
    expect([...INCIDENT_STATUSES]).toEqual([
      'DRAFT',
      'VALIDATED',
      'SUBMITTED',
      'ACCEPTED',
      'REJECTED',
    ]);
  });
});

describe('createIncidentRepository', () => {
  it('persists INCIDENT with pk DEPT#deptId#INCIDENT#incidentId, sk METADATA, nerisSchemaVersion, and opaque corePayload (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);
    const now = 1_798_000_100;

    const result = await repository.createIncident(DEPT_ID, BASE_INPUT, now);

    const expectedId = 'NICHOLS-4471-1798000000';
    expect(result).toMatchObject({
      incidentId: expectedId,
      sourceDispatchId: expectedId,
      deptId: 'NICHOLS',
      dispatchNumber: '4471',
      epochSeconds: 1_798_000_000,
      nerisSchemaVersion: '2026.2',
      corePayload: BASE_INPUT.corePayload,
      status: 'DRAFT',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
    });

    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        pk: `DEPT#NICHOLS#INCIDENT#${expectedId}`,
        sk: 'METADATA',
        entityType: 'INCIDENT',
        incidentId: expectedId,
        sourceDispatchId: expectedId,
        nerisSchemaVersion: '2026.2',
        corePayload: BASE_INPUT.corePayload,
        status: 'DRAFT',
        gsi1pk: 'DEPT#NICHOLS',
        gsi1sk: 'INCIDENT#1798000000',
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('sets incidentId equal to the originating dispatch NERIS-format ID (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100);

    expect(result.incidentId).toBe(buildNerisIncidentId('NICHOLS', '4471', 1_798_000_000));
    expect(result.incidentId).toBe(result.sourceDispatchId);
  });

  it('rejects a status outside DRAFT|VALIDATED|SUBMITTED|ACCEPTED|REJECTED (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.createIncident(
        DEPT_ID,
        { ...BASE_INPUT, status: 'OPEN' as 'DRAFT' },
        1_798_000_100,
      ),
    ).rejects.toThrow(InvalidIncidentStatusError);
    expect(send).not.toHaveBeenCalled();
  });

  it('persists an explicit VALIDATED status when provided', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.createIncident(
      DEPT_ID,
      { ...BASE_INPUT, status: 'VALIDATED' },
      1_798_000_100,
    );

    expect(result.status).toBe('VALIDATED');
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect((command.input.Item as Record<string, unknown>).status).toBe('VALIDATED');
  });

  it('gets an incident by pk/sk via GetItem', async () => {
    const item = {
      pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
      sk: 'METADATA',
      entityType: 'INCIDENT',
      incidentId: 'NICHOLS-4471-1798000000',
      deptId: 'NICHOLS',
      dispatchNumber: '4471',
      epochSeconds: 1_798_000_000,
      nerisSchemaVersion: '2026.2',
      corePayload: { opaque: true },
      status: 'DRAFT',
      sourceDispatchId: 'NICHOLS-4471-1798000000',
      createdBy: 'MBR-0034',
      createdAt: 1_798_000_100,
      updatedAt: 1_798_000_100,
    };
    const send = vi.fn().mockResolvedValue({ Item: item });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.getIncident(DEPT_ID, 'NICHOLS-4471-1798000000');

    expect(result).toMatchObject({
      incidentId: 'NICHOLS-4471-1798000000',
      nerisSchemaVersion: '2026.2',
      corePayload: { opaque: true },
      status: 'DRAFT',
    });
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      Key: {
        pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
        sk: 'METADATA',
      },
    });
  });

  it('returns undefined when no incident matches', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(repository.getIncident(DEPT_ID, 'NICHOLS-9999-1')).resolves.toBeUndefined();
  });

  it('rejects a duplicate incidentId as DuplicateIncidentError', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'dup', $metadata: {} }));
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100)).rejects.toThrow(
      DuplicateIncidentError,
    );
  });
});

describe('getTableName', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when INCIDENT_TABLE_NAME is unset', () => {
    const env = { ...process.env };
    delete env.INCIDENT_TABLE_NAME;
    expect(() => getTableName(env)).toThrow(/INCIDENT_TABLE_NAME/);
  });

  it('returns the configured table name when set', () => {
    expect(getTableName({ INCIDENT_TABLE_NAME: 'boxalarm-dev-incident' })).toBe(
      'boxalarm-dev-incident',
    );
  });
});

describe('getDocumentClient', () => {
  it('memoizes the DynamoDB document client across calls', () => {
    expect(getDocumentClient()).toBe(getDocumentClient());
  });
});
