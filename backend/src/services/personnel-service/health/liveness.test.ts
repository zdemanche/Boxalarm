import { describe, expect, it } from 'vitest';
import { handler } from './liveness.js';

describe('handler', () => {
  it('always returns 200', async () => {
    const result = (await handler({} as never, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
  });
});
