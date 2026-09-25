import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import { loadHydrantFlowTests, loadIsoReport } from './repository.js';

describe('ISO source reads', () => {
  it('queries one GSI2 partition per month in the range', async () => {
    const commands: QueryCommand[] = [];
    const send = vi.fn((command: QueryCommand) => {
      commands.push(command);
      const pk: unknown = command.input.ExpressionAttributeValues
        ? command.input.ExpressionAttributeValues[':pk']
        : undefined;
      if (pk === 'DEPT#NICHOLS#DUE#HYDRANT#2026-01') {
        return { Items: [{ hydrantId: 'H1', nextFlowTestDue: '2026-01-20' }] };
      }
      return { Items: [{ hydrantId: 'H2', nextFlowTestDue: '2026-02-10' }] };
    });
    const from = Date.parse('2026-01-15T00:00:00.000Z') / 1000;
    const to = Date.parse('2026-02-10T00:00:00.000Z') / 1000;
    const section = await loadHydrantFlowTests(
      { send } as unknown as DynamoDBDocumentClient,
      'platform',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      from,
      to,
    );
    expect(commands.map((command) => command.input.IndexName)).toEqual(['GSI2', 'GSI2']);
    expect(section.count).toBe(2);
  });

  it('returns an empty section when one source domain throws', async () => {
    const send = vi.fn((command: QueryCommand) => {
      if (command.input.IndexName === 'GSI1') {
        throw new Error('incident table down');
      }
      return { Items: [] };
    });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const report = await loadIsoReport(
      client,
      client,
      'platform',
      'incident',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      100,
      200,
    );
    expect(report.trainingHours.totalHours).toBe(0);
    expect(report.apparatusTests.byType).toEqual([]);
    expect(report.responseTimes.total.sampleCount).toBe(0);
    expect(report.responseTimes.total.excludedCount).toBe(0);
  });
});
