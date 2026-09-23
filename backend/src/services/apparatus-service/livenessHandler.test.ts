import { describe, expect, it } from 'vitest';

describe('livenessHandler', () => {
  it('returns 200 unconditionally', async () => {
    const { handler } = await import('./livenessHandler.js');
    const result = await handler();
    expect(result).toMatchObject({ statusCode: 200 });
  });
});
