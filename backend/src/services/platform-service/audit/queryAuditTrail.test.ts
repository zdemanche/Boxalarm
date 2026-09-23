import { describe, expect, it, vi } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildAuditLogEntryItem } from './auditEntry.js';
import { InvalidCursorError, queryAuditTrailForEntity } from './queryAuditTrail.js';

const DEPT_ID: VerifiedDeptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('queryAuditTrailForEntity', () => {
  it('throws when mutatedEntityType is missing', async () => {
    await expect(
      queryAuditTrailForEntity({ send: vi.fn() } as never, 'table', DEPT_ID, '', 'CERT-0091'),
    ).rejects.toThrow(/mutatedEntityType/);
  });

  it('throws when mutatedEntityId is missing', async () => {
    await expect(
      queryAuditTrailForEntity({ send: vi.fn() } as never, 'table', DEPT_ID, 'CERTIFICATION', ''),
    ).rejects.toThrow(/mutatedEntityId/);
  });

  it('queries GSI3 on the dept-scoped entity key, newest first, per AP43', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await queryAuditTrailForEntity(
      { send } as never,
      'platform-table',
      DEPT_ID,
      'CERTIFICATION',
      'CERT-0091',
    );
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.TableName).toBe('platform-table');
    expect(command.input.IndexName).toBe('GSI3');
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':gsi3pk': 'DEPT#NICHOLS#AUDIT#ENTITY#CERTIFICATION#CERT-0091',
    });
    expect(command.input.ScanIndexForward).toBe(false);
    expect(command.input.Limit).toBe(25);
  });

  it('throws InvalidCursorError (not a generic Error) on a malformed cursor', async () => {
    await expect(
      queryAuditTrailForEntity(
        { send: vi.fn() } as never,
        'table',
        DEPT_ID,
        'CERTIFICATION',
        'CERT-0091',
        'not-valid-base64url-json',
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('returns an empty entries array when the record has zero audit entries', async () => {
    const send = vi.fn().mockResolvedValue({});
    const page = await queryAuditTrailForEntity(
      { send } as never,
      'table',
      DEPT_ID,
      'CERTIFICATION',
      'CERT-NEW',
    );
    expect(page).toEqual({ entries: [] });
  });

  it('parses returned items and paginates via an opaque cursor round trip (N8.3 usability)', async () => {
    const item = buildAuditLogEntryItem({
      deptId: DEPT_ID,
      actorId: 'MBR-0034',
      mutatedEntityType: 'CERTIFICATION',
      mutatedEntityId: 'CERT-0091',
      action: 'UPDATE',
      before: { expiryDate: '2026-01-10' },
      after: { expiryDate: '2027-01-10' },
    });
    const lastEvaluatedKey = { pk: item.pk, sk: item.sk };
    const send = vi.fn().mockResolvedValue({ Items: [item], LastEvaluatedKey: lastEvaluatedKey });

    const page = await queryAuditTrailForEntity(
      { send } as never,
      'table',
      DEPT_ID,
      'CERTIFICATION',
      'CERT-0091',
    );
    expect(page.entries).toEqual([item]);
    expect(page.nextCursor).toBeTruthy();

    await queryAuditTrailForEntity(
      { send } as never,
      'table',
      DEPT_ID,
      'CERTIFICATION',
      'CERT-0091',
      page.nextCursor,
    );
    const secondCommand = send.mock.calls[1]?.[0] as QueryCommand;
    expect(secondCommand.input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });
});
