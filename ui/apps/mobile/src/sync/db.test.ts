import type { DB } from '@op-engineering/op-sqlite';

// m7: a failed first initialisation must not be cached for the life of the process.
test('a database whose tables could not be created is not cached; the next call retries', () => {
  jest.isolateModules(() => {
    const statements: string[] = [];
    let failNext = true;
    const fakeDb = {
      executeSync: jest.fn((sql: string) => {
        if (failNext && sql.includes('CREATE TABLE IF NOT EXISTS outbox')) {
          failNext = false;
          throw new Error('disk I/O error');
        }
        statements.push(sql.trim().split(/\s+/).slice(0, 6).join(' ').replace(/ \($/, ''));
        return { rows: [] };
      }),
      close: jest.fn(),
    };
    const open = jest.fn(() => fakeDb as unknown as DB);
    jest.doMock('@op-engineering/op-sqlite', () => ({ open }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('./db') as typeof import('./db');

    expect(() => getDb()).toThrow('disk I/O error');
    expect(fakeDb.close).toHaveBeenCalledTimes(1);

    expect(getDb()).toBe(fakeDb);
    expect(open).toHaveBeenCalledTimes(2);
    expect(statements).toEqual(
      expect.arrayContaining([
        'CREATE TABLE IF NOT EXISTS outbox',
        'CREATE TABLE IF NOT EXISTS kv',
      ]),
    );
    // Cached once whole.
    expect(getDb()).toBe(fakeDb);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
