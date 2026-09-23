import { describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDispatchDetail, getPrePlanCopy } from './repository.js';

const TABLE_NAME = 'alerting-dispatches';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('getDispatchDetail', () => {
  it('builds the DISPATCH_ALERT key via buildDeptScopedPk and returns the item', async () => {
    const doc = mockClient(DynamoDBDocumentClient);
    doc.on(GetCommand).resolves({ Item: { dispatchId: 'NICHOLS-4471-1798000000' } });

    const result = await getDispatchDetail(
      doc as unknown as DynamoDBDocumentClient,
      TABLE_NAME,
      DEPT_ID,
      'NICHOLS-4471-1798000000',
    );

    expect(result).toEqual({ dispatchId: 'NICHOLS-4471-1798000000' });
    expect(doc.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798000000', sk: 'METADATA' },
    });
  });

  it('returns undefined when no item exists', async () => {
    const doc = mockClient(DynamoDBDocumentClient);
    doc.on(GetCommand).resolves({});

    const result = await getDispatchDetail(
      doc as unknown as DynamoDBDocumentClient,
      TABLE_NAME,
      DEPT_ID,
      'missing',
    );

    expect(result).toBeUndefined();
  });
});

describe('getPrePlanCopy', () => {
  it('builds the PRE_PLAN_COPY key on the dept-scoped PREPLAN partition', async () => {
    const doc = mockClient(DynamoDBDocumentClient);
    doc.on(GetCommand).resolves({ Item: { summary: 'LPG tank rear' } });

    const result = await getPrePlanCopy(
      doc as unknown as DynamoDBDocumentClient,
      TABLE_NAME,
      DEPT_ID,
      'OCC-0231',
    );

    expect(result).toEqual({ summary: 'LPG tank rear' });
    expect(doc.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' },
    });
  });
});
