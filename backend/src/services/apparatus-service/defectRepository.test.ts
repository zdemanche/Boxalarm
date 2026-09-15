import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  ApparatusNotFoundError,
  DuplicateDefectReportError,
  createDefect,
  getDefectByIdempotencyKey,
} from './defectRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function apparatusGsiItem(unitId = 'E1', apparatusId = 'APP-E1') {
  return {
    pk: `DEPT#NICHOLS#APPARATUS#${apparatusId}`,
    sk: 'METADATA',
    unitId,
    apparatusId,
    type: 'ENGINE',
    status: 'IN_SERVICE',
    gsi3pk: 'DEPT#NICHOLS#APPARATUS',
    gsi3sk: unitId,
  };
}

describe('createDefect', () => {
  it('writes DEFECT OPEN + apparatus.defect.reported outbox in one TransactWriteItems', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [apparatusGsiItem()] };
      }
      if (command instanceof TransactWriteCommand) {
        return {};
      }
      throw new Error('unexpected command');
    });
    const client = fakeClient(send);

    const defect = await createDefect(client, 'platform-table', {
      deptId: DEPT_ID,
      unitId: 'E1',
      description: 'Low tire pressure, rear axle',
      severity: 'MAJOR',
      reportedByMemberId: 'MBR-0012',
      correlationId: 'trace-1',
      photoS3Key: 'NICHOLS/defect/DEF-1/photo.jpg',
      now: () => 1798050000,
      defectId: 'DEF-1',
    });

    expect(defect).toMatchObject({
      defectId: 'DEF-1',
      apparatusId: 'APP-E1',
      unitId: 'E1',
      description: 'Low tire pressure, rear axle',
      severity: 'MAJOR',
      status: 'OPEN',
      reportedBy: 'MBR-0012',
      reportedAt: 1798050000,
      photoS3Key: 'NICHOLS/defect/DEF-1/photo.jpg',
      outOfService: false,
    });

    const transact = send.mock.calls.find(
      (call) => call[0] instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand | undefined;
    const items = transact?.input.TransactItems ?? [];
    expect(items).toHaveLength(2);

    const defectPut = items[0]?.Put?.Item as Record<string, unknown>;
    expect(defectPut).toMatchObject({
      pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
      sk: 'DEFECT#DEF-1',
      entityType: 'DEFECT',
      status: 'OPEN',
      severity: 'MAJOR',
      gsi3pk: 'DEPT#NICHOLS#DEFECT',
      gsi3sk: 'OPEN#1798050000',
      photoS3Key: 'NICHOLS/defect/DEF-1/photo.jpg',
    });

    const outboxPut = items[1]?.Put?.Item as Record<string, unknown>;
    expect(outboxPut).toMatchObject({
      entityType: 'OUTBOX_RECORD',
      eventType: 'apparatus.defect.reported',
      source: 'apparatus-service',
      pk: 'DEPT#NICHOLS#OUTBOX',
      payload: {
        defectId: 'DEF-1',
        apparatusId: 'APP-E1',
        unitLabel: 'E1',
        reportedByMemberId: 'MBR-0012',
        severity: 'MAJOR',
        photoS3Key: 'NICHOLS/defect/DEF-1/photo.jpg',
        outOfService: false,
        deptId: 'NICHOLS',
      },
    });
  });

  it('includes an idempotency item when clientMutationId is provided', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [apparatusGsiItem()] };
      }
      if (command instanceof TransactWriteCommand) {
        return {};
      }
      throw new Error('unexpected command');
    });

    await createDefect(fakeClient(send), 'platform-table', {
      deptId: DEPT_ID,
      unitId: 'E1',
      description: 'Brake fade',
      severity: 'OUT_OF_SERVICE',
      reportedByMemberId: 'MBR-0012',
      correlationId: 'trace-2',
      clientMutationId: 'offline-mut-99',
      now: () => 1798050000,
      defectId: 'DEF-2',
    });

    const transact = send.mock.calls.find(
      (call) => call[0] instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand | undefined;
    const items = transact?.input.TransactItems ?? [];
    expect(items).toHaveLength(3);

    const idempotencyPut = items[2]?.Put;
    expect(idempotencyPut?.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
      sk: 'IDEMPOTENCY#DEFECT#offline-mut-99',
      entityType: 'DEFECT_IDEMPOTENCY',
      defectId: 'DEF-2',
    });
    expect(idempotencyPut?.ConditionExpression).toBe('attribute_not_exists(sk)');

    const outboxPut = items[1]?.Put?.Item as {
      payload: { outOfService: boolean; severity: string };
    };
    expect(outboxPut.payload.severity).toBe('OUT_OF_SERVICE');
    expect(outboxPut.payload.outOfService).toBe(true);
  });

  it('throws ApparatusNotFoundError when the unitId is unknown', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [] };
      }
      throw new Error('unexpected command');
    });

    await expect(
      createDefect(fakeClient(send), 'platform-table', {
        deptId: DEPT_ID,
        unitId: 'MISSING',
        description: 'x',
        severity: 'MINOR',
        reportedByMemberId: 'MBR-0012',
        correlationId: 'trace-3',
      }),
    ).rejects.toBeInstanceOf(ApparatusNotFoundError);
  });

  it('throws DuplicateDefectReportError when the idempotency conditional put fails', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [apparatusGsiItem()] };
      }
      if (command instanceof TransactWriteCommand) {
        throw new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        });
      }
      throw new Error('unexpected command');
    });

    await expect(
      createDefect(fakeClient(send), 'platform-table', {
        deptId: DEPT_ID,
        unitId: 'E1',
        description: 'x',
        severity: 'MINOR',
        reportedByMemberId: 'MBR-0012',
        correlationId: 'trace-4',
        clientMutationId: 'replay-1',
        defectId: 'DEF-3',
      }),
    ).rejects.toBeInstanceOf(DuplicateDefectReportError);
  });
});

describe('getDefectByIdempotencyKey', () => {
  it('loads the defect referenced by the idempotency item', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof QueryCommand && command.input.IndexName === 'GSI3') {
        return { Items: [apparatusGsiItem()] };
      }
      if (command instanceof QueryCommand) {
        return {
          Items: [
            {
              pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
              sk: 'IDEMPOTENCY#DEFECT#replay-1',
              defectId: 'DEF-3',
            },
          ],
        };
      }
      if (command instanceof GetCommand) {
        return {
          Item: {
            pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
            sk: 'DEFECT#DEF-3',
            entityType: 'DEFECT',
            defectId: 'DEF-3',
            apparatusId: 'APP-E1',
            unitId: 'E1',
            description: 'x',
            severity: 'MINOR',
            status: 'OPEN',
            reportedBy: 'MBR-0012',
            reportedAt: 1798050000,
            photoS3Key: null,
          },
        };
      }
      throw new Error('unexpected command');
    });

    const defect = await getDefectByIdempotencyKey(fakeClient(send), 'platform-table', {
      deptId: DEPT_ID,
      unitId: 'E1',
      clientMutationId: 'replay-1',
    });

    expect(defect?.defectId).toBe('DEF-3');
    expect(defect?.status).toBe('OPEN');
  });
});
