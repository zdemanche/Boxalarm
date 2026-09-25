import { LambdaClient } from '@aws-sdk/client-lambda';
import type { GuardEvent } from '@boxalarm/authz';
import { describe, expect, it } from 'vitest';
import { readDeliveryBaseline } from './deliveryBaseline.js';

describe('readDeliveryBaseline', () => {
  it('reads the alerting delivery-baseline lambda and does not query a table itself', async () => {
    const lambda = viSend();
    const view = await readDeliveryBaseline(
      {
        DELIVERY_BASELINE_FUNCTION_NAME: 'boxalarm-dev-alerting-delivery-baseline',
        CUTOVER_DELIVERY_RATE_THRESHOLD: '0.95',
      },
      {
        headers: {},
        requestContext: { authorizer: { lambda: { deptId: 'NICHOLS' } } },
      } as GuardEvent,
      10,
      20,
      lambda as unknown as LambdaClient,
    );
    expect(view.deliveryRate).toBe(0.5);
    expect(view.missedPageCount).toBe(3);
    expect(view.timeToFirstAckMedianSeconds).toBe(8);
    expect(view.perMember[0]).toMatchObject({ memberId: 'm-1', deliveryRate: 0.5 });
    expect(view.meetsThreshold).toBe(false);
    expect(lambda.mock.calls[0]?.[0]?.input.FunctionName).toBe(
      'boxalarm-dev-alerting-delivery-baseline',
    );
  });
});

function viSend() {
  return {
    mock: { calls: [] as { input: { FunctionName: string } }[][] },
    send(command: { input: { FunctionName: string } }) {
      this.mock.calls.push([command]);
      return {
        Payload: Buffer.from(
          JSON.stringify({
            statusCode: 200,
            body: JSON.stringify({
              deliveryRate: 0.5,
              missedPageCount: 3,
              timeToFirstAckAverageSeconds: 9,
              timeToFirstAckMedianSeconds: 8,
              perMember: [{ memberId: 'm-1', sent: 4, delivered: 2, missedPageCount: 1 }],
            }),
          }),
        ),
      };
    },
  };
}
