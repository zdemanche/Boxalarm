import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export function handler(): Promise<APIGatewayProxyResultV2> {
  return Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });
}
