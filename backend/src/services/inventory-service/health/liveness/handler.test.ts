import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from './handler.js';

describe('handler (GET /api/v1/inventory/health/liveness)', () => {
  it('returns 200 with no dependency checks (entrypoint-test)', async () => {
    const result = await handler({} as APIGatewayProxyEventV2);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ status: 'ok' });
  });
});
