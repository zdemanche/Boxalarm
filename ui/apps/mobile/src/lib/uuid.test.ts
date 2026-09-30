import { uuidV4 } from './uuid';

test('uuidV4 is a v4 UUID inside the server clientAnswerId pattern, and unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => uuidV4()));
  expect(ids.size).toBe(200);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  }
});

test('works without crypto.getRandomValues', () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    expect(uuidV4()).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  }
});
