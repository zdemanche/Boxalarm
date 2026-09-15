import { describe, expect, it, vi } from 'vitest';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ApparatusListItem } from './repository.js';
import { computeComplianceReport, queryChecklistRunsInRange } from './complianceReport.js';

const DEPT_ID = 'dept-001' as never;

function fakeClient(pages: readonly { Items: readonly unknown[]; LastEvaluatedKey?: unknown }[]) {
  let call = 0;
  const send = vi.fn(() => {
    const page = pages[call] ?? { Items: [] };
    call += 1;
    return Promise.resolve(page);
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('queryChecklistRunsInRange', () => {
  it('queries GSI3 with a gsi3sk BETWEEN condition scoped to CHECKLIST_RUN', async () => {
    const client = fakeClient([{ Items: [] }]);

    await queryChecklistRunsInRange(client, 'platform-table', DEPT_ID, 1798000000, 1798100000);

    const command = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as QueryCommand;
    expect(command.input.IndexName).toBe('GSI3');
    expect(command.input.KeyConditionExpression).toBe(
      'gsi3pk = :gsi3pk AND gsi3sk BETWEEN :from AND :to',
    );
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':gsi3pk': 'DEPT#dept-001#CHECKLIST_RUN',
      ':from': 1798000000,
      ':to': 1798100000,
    });
  });

  it('parses apparatusId from pk and completedAt from gsi3sk, skipping malformed items', async () => {
    const client = fakeClient([
      {
        Items: [
          { pk: 'DEPT#dept-001#APPARATUS#APP-1', sk: 'CHECK#1798000100', gsi3sk: 1798000100 },
          { pk: 'DEPT#dept-001#NOT-APPARATUS#X', gsi3sk: 1798000200 },
        ],
      },
    ]);

    const runs = await queryChecklistRunsInRange(
      client,
      'platform-table',
      DEPT_ID,
      1798000000,
      1798100000,
    );

    expect(runs).toEqual([{ apparatusId: 'APP-1', completedAt: 1798000100 }]);
  });

  it('follows LastEvaluatedKey pagination across pages', async () => {
    const client = fakeClient([
      {
        Items: [{ pk: 'DEPT#dept-001#APPARATUS#APP-1', gsi3sk: 1798000100 }],
        LastEvaluatedKey: { pk: 'x', sk: 'y' },
      },
      { Items: [{ pk: 'DEPT#dept-001#APPARATUS#APP-2', gsi3sk: 1798000200 }] },
    ]);

    const runs = await queryChecklistRunsInRange(
      client,
      'platform-table',
      DEPT_ID,
      1798000000,
      1798100000,
    );

    expect((client.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(runs.map((r) => r.apparatusId)).toEqual(['APP-1', 'APP-2']);
  });

  it('wraps a Dynamo failure as ApparatusRepositoryUnavailableError, logging the original error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      send: vi.fn().mockRejectedValue(new Error('table throttled')),
    } as unknown as DynamoDBDocumentClient;

    await expect(
      queryChecklistRunsInRange(client, 'platform-table', DEPT_ID, 1798000000, 1798100000),
    ).rejects.toThrow('The apparatus data store is temporarily unavailable');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('apparatus.complianceReport.queryChecklistRuns.failed'),
    );
    errorSpy.mockRestore();
  });
});

describe('computeComplianceReport', () => {
  const roster: readonly ApparatusListItem[] = [
    { unitId: 'ENGINE-1', type: 'ENGINE', status: 'IN_SERVICE' },
    { unitId: 'LADDER-1', type: 'LADDER', status: 'IN_SERVICE' },
  ];

  it('flags an apparatus with zero completed checks as non-compliant rather than omitting it (AC2)', () => {
    const report = computeComplianceReport(roster, [], 1798000000, 1798000000 + 2 * 86400);

    expect(report).toHaveLength(2);
    expect(report).toContainEqual({
      unitId: 'LADDER-1',
      expectedChecks: 3,
      actualChecks: 0,
      compliant: false,
    });
  });

  it('marks compliant when actual checks meet or exceed the expected daily cadence (AC1)', () => {
    const from = 1798000000;
    const to = from + 2 * 86400;
    const report = computeComplianceReport(
      roster,
      [
        { apparatusId: 'ENGINE-1', completedAt: from },
        { apparatusId: 'ENGINE-1', completedAt: from + 86400 },
        { apparatusId: 'ENGINE-1', completedAt: from + 2 * 86400 },
      ],
      from,
      to,
    );

    expect(report).toContainEqual({
      unitId: 'ENGINE-1',
      expectedChecks: 3,
      actualChecks: 3,
      compliant: true,
    });
  });

  it('returns an empty report for an empty roster rather than throwing', () => {
    expect(computeComplianceReport([], [], 1798000000, 1798000000)).toEqual([]);
  });
});
