import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = (): Promise<APIGatewayProxyResultV2> =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });
