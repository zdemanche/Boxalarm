import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import { loadResponseUnitSamples } from './repository.js';

describe('loadResponseUnitSamples', () => {
  it('queries incident GSI1 by date range and never scans', async () => {
    const commands: QueryCommand[] = [];
    const send = vi.fn((command: QueryCommand) => {
      commands.push(command);
      if (commands.length === 1) {
        return { Items: [{ incidentId: 'inc-1' }] };
      }
      return {
        Items: [{ unitId: 'E1', dispatchedAt: 10, enRouteAt: 20, arrivedAt: 40 }],
      };
    });
    const samples = await loadResponseUnitSamples(
      { send } as unknown as DynamoDBDocumentClient,
      'incident-table',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      100,
      200,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]?.input.IndexName).toBe('GSI1');
    expect(commands[0]?.input.KeyConditionExpression).toContain('BETWEEN');
    expect(commands[0]?.input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'DEPT#NICHOLS',
      ':from': 'INCIDENT#100',
      ':to': 'INCIDENT#200',
    });
    expect(commands.every((command) => command instanceof QueryCommand)).toBe(true);
    expect(samples).toEqual([
      { incidentId: 'inc-1', unitId: 'E1', dispatchedAt: 10, enRouteAt: 20, arrivedAt: 40 },
    ]);
  });
});
