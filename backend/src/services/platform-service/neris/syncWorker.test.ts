import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ddbSend, syncEntity, saveEntityRecord } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  syncEntity: vi.fn(),
  saveEntityRecord: vi.fn(),
}));

vi.mock('../export/awsClients.js', () => ({ getDynamoDocClient: () => ({ send: ddbSend }) }));
vi.mock('../../incident-service/neris/index.js', () => ({
  getNerisClient: () => ({}),
  readNerisConfig: () => Promise.resolve({}),
}));
vi.mock('./entitySync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entitySync.js')>();
  return { ...actual, syncEntity, saveEntityRecord };
});

process.env.PLATFORM_TABLE_NAME = 'platform-table';

import { handler } from './syncWorker.js';

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

const REQUEST = { stations: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('NERIS entity sync worker', () => {
  it('runs the pending request and saves the result', async () => {
    ddbSend.mockImplementation((command: Command) =>
      Promise.resolve(
        (command.input.Key as { sk: string }).sk === 'CONFIG#NERIS'
          ? { Item: { value: { departmentNerisId: 'FD09190828' } } }
          : { Item: { syncStatus: 'SYNCING', pendingRequest: REQUEST, requestedBy: 'chief-1' } },
      ),
    );
    syncEntity.mockResolvedValue({
      departmentNerisId: 'FD09190828',
      stations: [],
      units: [],
      errors: [],
    });
    await handler({ deptId: 'NICHOLS', correlationId: 'c' }, {} as never, () => undefined);
    expect(syncEntity).toHaveBeenCalledWith(
      expect.anything(),
      'FD09190828',
      REQUEST,
      expect.objectContaining({ syncStatus: 'SYNCING' }),
      'chief-1',
      expect.any(Date),
    );
    expect(saveEntityRecord).toHaveBeenCalled();
  });

  it('does nothing when no sync is pending', async () => {
    ddbSend.mockResolvedValue({ Item: { syncStatus: 'SYNCED' } });
    await handler({ deptId: 'NICHOLS', correlationId: 'c' }, {} as never, () => undefined);
    expect(syncEntity).not.toHaveBeenCalled();
  });
});
