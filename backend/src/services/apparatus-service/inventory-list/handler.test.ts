import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

function buildEvent(
  pathParameters: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/{unitId}/inventory',
    rawPath: '/api/v1/apparatus/ENGINE-2/inventory',
    rawQueryString: '',
    headers,
    pathParameters,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

vi.mock('../inventory/compartmentItemRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inventory/compartmentItemRepository.js')>();
  return { ...actual, listCompartmentItems: vi.fn() };
});

describe('inventory-list handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('returns 200 with items grouped by compartmentCode (AC1)', async () => {
    const { listInventory } = await import('./handler.js');
    const { listCompartmentItems } = await import('../inventory/compartmentItemRepository.js');
    vi.mocked(listCompartmentItems).mockResolvedValue([
      { itemId: 'CI-001', compartmentCode: 'C1', itemName: 'Halligan', quantity: 1 },
      { itemId: 'CI-002', compartmentCode: 'C1', itemName: 'Axe', quantity: 2 },
      { itemId: 'CI-003', compartmentCode: 'C2', itemName: 'Rope', quantity: 3 },
    ]);

    const result = (await listInventory(buildEvent({ unitId: 'ENGINE-2' }), PRINCIPAL)) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as {
      compartments: { compartmentCode: string; items: unknown[] }[];
    };
    expect(body.compartments).toHaveLength(2);
    const c1 = body.compartments.find((c) => c.compartmentCode === 'C1');
    expect(c1?.items).toHaveLength(2);
    expect(vi.mocked(listCompartmentItems)).toHaveBeenCalledWith(
      expect.anything(),
      'platform-service',
      'dept-001',
      'ENGINE-2',
    );
  });

  it('returns 200 with an empty compartments list for an apparatus with no items (empty-input row)', async () => {
    const { listInventory } = await import('./handler.js');
    const { listCompartmentItems } = await import('../inventory/compartmentItemRepository.js');
    vi.mocked(listCompartmentItems).mockResolvedValue([]);

    const result = (await listInventory(buildEvent({ unitId: 'ENGINE-9' }), PRINCIPAL)) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ compartments: [] });
  });

  it('returns 400 when the unitId path parameter is absent', async () => {
    const { listInventory } = await import('./handler.js');
    const result = (await listInventory(buildEvent(undefined), PRINCIPAL)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when unitId contains the pk delimiter (#-bearing path parameter row)', async () => {
    const { listInventory } = await import('./handler.js');
    const { listCompartmentItems, CompartmentItemInvalidKeyError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(listCompartmentItems).mockRejectedValue(
      new CompartmentItemInvalidKeyError('unitId', 'EN#G'),
    );

    const result = (await listInventory(buildEvent({ unitId: 'EN#G' }), PRINCIPAL)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when the principal deptId contains the pk delimiter, without invoking the repository', async () => {
    const { listInventory } = await import('./handler.js');
    const { listCompartmentItems } = await import('../inventory/compartmentItemRepository.js');
    const result = (await listInventory(
      buildEvent({ unitId: 'ENGINE-2' }, { ...PRINCIPAL, deptId: 'DEPT#1' }),
      { ...PRINCIPAL, deptId: 'DEPT#1' },
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(vi.mocked(listCompartmentItems)).not.toHaveBeenCalled();
  });

  it('returns 503 (fail-closed, never a silent 200) when DynamoDB is unavailable', async () => {
    const { listInventory } = await import('./handler.js');
    const { listCompartmentItems, CompartmentItemStoreUnavailableError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(listCompartmentItems).mockRejectedValue(
      new CompartmentItemStoreUnavailableError(new Error('x')),
    );

    const result = (await listInventory(buildEvent({ unitId: 'ENGINE-2' }), PRINCIPAL)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
  });

  it('rethrows an unexpected error rather than swallowing it', async () => {
    const { listInventory } = await import('./handler.js');
    const { listCompartmentItems } = await import('../inventory/compartmentItemRepository.js');
    vi.mocked(listCompartmentItems).mockRejectedValue(new TypeError('boom'));

    await expect(listInventory(buildEvent({ unitId: 'ENGINE-2' }), PRINCIPAL)).rejects.toThrow(
      'boom',
    );
  });

  it('denies with 403 before invoking any dependency when the bearer token is missing (entrypoint test, exported handler)', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(buildEvent({ unitId: 'ENGINE-2' }, PRINCIPAL, {}))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(403);
  });
});
