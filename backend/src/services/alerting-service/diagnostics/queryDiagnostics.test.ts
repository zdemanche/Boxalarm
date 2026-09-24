import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryMemberDiagnostics } from './queryDiagnostics.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeClient(items: Record<string, Record<string, unknown>>): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items[`${key.pk}#${key.sk}`] });
    }
    if (name === 'QueryCommand') {
      const query = input as {
        ExpressionAttributeValues: Record<string, unknown>;
        FilterExpression?: string;
      };
      const pk = query.ExpressionAttributeValues[':pk'];
      const allowedEntityTypes = query.FilterExpression
        ? ['t0', 't1', 't2']
            .map((key) => query.ExpressionAttributeValues[`:${key}`])
            .filter((value): value is string => typeof value === 'string')
        : undefined;
      const memberId = query.ExpressionAttributeValues[':memberId'] as string | undefined;
      return Promise.resolve({
        Items: Object.values(items).filter(
          (item) =>
            item.pk === pk &&
            (!allowedEntityTypes || allowedEntityTypes.includes(item.entityType as string)) &&
            (!memberId || item.memberId === memberId),
        ),
      });
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('queryMemberDiagnostics', () => {
  it('distinguishes "not on eligible roster" from "sent but not delivered" (AC5)', async () => {
    const client = fakeClient({});
    const result = await queryMemberDiagnostics(
      client,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      'mbr-1',
    );
    expect(result.onEligibleRoster).toBe(false);
    expect(result.timeline).toEqual([]);
  });

  it('returns the member-filtered timeline and device state when the member is on the roster (AC1, AC2)', async () => {
    const pk = 'DEPT#NICHOLS#DISPATCH#dispatch-1';
    const client = fakeClient({
      [`${pk}#ROSTER#mbr-1`]: { pk, sk: 'ROSTER#mbr-1', memberId: 'mbr-1' },
      [`${pk}#RECEIPT#mbr-1#push#1`]: {
        pk,
        sk: 'RECEIPT#mbr-1#push#1',
        entityType: 'DELIVERY_RECEIPT',
        memberId: 'mbr-1',
        channel: 'push',
      },
      [`${pk}#RECEIPT#mbr-2#push#1`]: {
        pk,
        sk: 'RECEIPT#mbr-2#push#1',
        entityType: 'DELIVERY_RECEIPT',
        memberId: 'mbr-2',
        channel: 'push',
      },
      ['DEPT#NICHOLS#DEVICE#mbr-1#STATE']: {
        pk: 'DEPT#NICHOLS#DEVICE#mbr-1',
        sk: 'STATE',
        memberId: 'mbr-1',
        notificationPermission: true,
        criticalAlertPermission: false,
        batteryOptimizationExempt: true,
        appVersion: '1.0.0',
        osVersion: 'iOS 18',
        reportedAt: 100,
      },
    });

    const result = await queryMemberDiagnostics(
      client,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      'mbr-1',
    );

    expect(result.onEligibleRoster).toBe(true);
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0]).toMatchObject({ memberId: 'mbr-1', channel: 'push' });
    expect(result.deviceState).toMatchObject({ notificationPermission: true, appVersion: '1.0.0' });
  });
});
