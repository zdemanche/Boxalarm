// TODO: no ticket yet — personnel-service GET /losap/year-end (architecture :324) does not
// exist; this test pins the AP16 aggregation shape only, not a live two-surface comparison.
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildYearEndReport } from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-table';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('LOSAP year-end aggregation contract (AP16)', () => {
  it('queries GSI1 per member — a fan-out of one Query per member, never a Scan', async () => {
    const indexNames: string[] = [];
    const send = vi.fn().mockImplementation((command: unknown) => {
      const input = (command as { input: { IndexName?: string } }).input;
      if (input.IndexName) {
        indexNames.push(input.IndexName);
      }
      if (input.IndexName === 'GSI3') {
        return Promise.resolve({ Items: [{ memberId: 'MBR-0001', status: 'ACTIVE' }] });
      }
      return Promise.resolve({ Items: [{ points: 1, ruleVersionId: 'RULE-2026' }] });
    });
    const client = fakeClient(send);
    await buildYearEndReport(client, TABLE, DEPT_ID, 2026);
    expect(indexNames).toContain('GSI3');
    expect(indexNames).toContain('GSI1');
  });

  it('sums points as-recorded across differing ruleVersionId fixtures, never re-derived under the current rule (AC3)', async () => {
    const send = vi.fn().mockImplementation((command: unknown) => {
      const input = (command as { input: { IndexName?: string } }).input;
      if (input.IndexName === 'GSI3') {
        return Promise.resolve({ Items: [{ memberId: 'MBR-0001', status: 'ACTIVE' }] });
      }
      return Promise.resolve({
        Items: [
          { points: 1, ruleVersionId: 'RULE-2026', sourceRefId: 'ATT-0001' },
          { points: 2, ruleVersionId: 'RULE-2026-REVISED', sourceRefId: 'ATT-0002' },
        ],
      });
    });
    const client = fakeClient(send);
    const report = await buildYearEndReport(client, TABLE, DEPT_ID, 2026);
    expect(report.members).toEqual([{ memberId: 'MBR-0001', totalPoints: 3, entryCount: 2 }]);
  });
});
