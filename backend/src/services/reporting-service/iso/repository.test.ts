import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import { loadHydrantFlowTests, loadIsoReport } from './repository.js';

describe('ISO source reads', () => {
  it('classifies every live hydrant against the period end, not just those due inside the period', async () => {
    const metadata: Record<string, Record<string, unknown>> = {
      'DEPT#NICHOLS#HYDRANT#H1': { hydrantId: 'H1', nextFlowTestDue: '2027-03-10' },
      'DEPT#NICHOLS#HYDRANT#H2': { hydrantId: 'H2', nextFlowTestDue: '2025-11-01' },
      'DEPT#NICHOLS#HYDRANT#H3': {
        hydrantId: 'H3',
        nextFlowTestDue: '2027-01-01',
        archivedAt: '2026-05-01T00:00:00.000Z',
      },
    };
    const send = vi.fn((command: QueryCommand) => {
      const values = command.input.ExpressionAttributeValues ?? {};
      if (command.input.IndexName === 'GSI3') {
        expect(values[':pk']).toBe('DEPT#NICHOLS#HYDRANT');
        return { Items: [{ hydrantId: 'H1' }, { hydrantId: 'H2' }, { hydrantId: 'H3' }] };
      }
      expect(values[':sk']).toBe('METADATA');
      return { Items: [metadata[values[':pk'] as string]] };
    });
    const to = Date.parse('2026-12-31T00:00:00.000Z') / 1000;
    const section = await loadHydrantFlowTests(
      { send } as unknown as DynamoDBDocumentClient,
      'platform',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      to,
    );
    expect(section).toMatchObject({ count: 2, currentCount: 1, overdueCount: 1 });
  });

  it('bounds training events by epoch milliseconds when the report range is epoch seconds', async () => {
    const send = vi.fn((command: QueryCommand) => {
      const values = command.input.ExpressionAttributeValues ?? {};
      if (command.input.IndexName === 'GSI3' && values[':pk'] === 'DEPT#NICHOLS#TRAINING_EVENT') {
        const key = '1767250000000';
        const inRange = values[':from'] <= key && key <= values[':to'];
        return { Items: inRange ? [{ eventId: 'E1', category: 'LADDER_OPS' }] : [] };
      }
      if (String(values[':prefix']) === 'ATTENDEE#') {
        return { Items: [{ hours: 3 }] };
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
      1767225600,
      1767311999,
    );
    expect(report.trainingHours.totalHours).toBe(3);
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
