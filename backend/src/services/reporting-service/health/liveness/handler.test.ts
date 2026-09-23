import { describe, expect, it } from 'vitest';
import { handler } from './handler.js';

describe('reporting-service health liveness handler', () => {
  it('returns 200 ok', async () => {
    const result = await handler({} as never);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse(result.body as string)).toEqual({ status: 'ok' });
  });
});
