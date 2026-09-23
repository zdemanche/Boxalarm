import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

export const handler: APIGatewayProxyHandlerV2 = () =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });
