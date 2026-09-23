import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

function buildEvent(
  pathParameters: Record<string, string> | undefined,
  body: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/apparatus/{unitId}/inventory/{itemId}',
    rawPath: '/api/v1/apparatus/ENGINE-2/inventory/CI-021',
    rawQueryString: '',
    headers,
    pathParameters,
    body,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

vi.mock('../inventory/compartmentItemRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inventory/compartmentItemRepository.js')>();
  return { ...actual, updateCompartmentItemQuantity: vi.fn() };
});

describe('inventory-quantity handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('returns 200 with the updated quantity on a valid restock/consume (AC2)', async () => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const { updateCompartmentItemQuantity } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(updateCompartmentItemQuantity).mockResolvedValue(undefined);

    const result = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2', itemId: 'CI-021' }, JSON.stringify({ quantity: 7 })),
      PRINCIPAL,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ itemId: 'CI-021', quantity: 7 });
    expect(vi.mocked(updateCompartmentItemQuantity)).toHaveBeenCalledWith(
      expect.anything(),
      'platform-service',
      'dept-001',
      'ENGINE-2',
      'CI-021',
      7,
      'officer-1',
    );
  });

  it('returns 400 when unitId or itemId path parameters are absent', async () => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const missingItemId = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2' }, JSON.stringify({ quantity: 1 })),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(missingItemId.statusCode).toBe(400);
  });

  it.each([
    ['absent quantity', {}],
    ['negative quantity', { quantity: -1 }],
    ['string-typed quantity', { quantity: '5' }],
  ])('returns 400 for %s', async (_label, body) => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const result = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2', itemId: 'CI-021' }, JSON.stringify(body)),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when unitId or itemId contains the pk delimiter (#-bearing path parameter row)', async () => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const { updateCompartmentItemQuantity, CompartmentItemInvalidKeyError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(updateCompartmentItemQuantity).mockRejectedValue(
      new CompartmentItemInvalidKeyError('itemId', 'CI#021'),
    );

    const result = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2', itemId: 'CI#021' }, JSON.stringify({ quantity: 1 })),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when the principal deptId contains the pk delimiter, without invoking the repository', async () => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const { updateCompartmentItemQuantity } =
      await import('../inventory/compartmentItemRepository.js');
    const result = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2', itemId: 'CI-021' }, JSON.stringify({ quantity: 1 }), {
        ...PRINCIPAL,
        deptId: 'DEPT#1',
      }),
      { ...PRINCIPAL, deptId: 'DEPT#1' },
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(vi.mocked(updateCompartmentItemQuantity)).not.toHaveBeenCalled();
  });

  it('returns 404 when itemId is unknown (conditional-update miss)', async () => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const { updateCompartmentItemQuantity, CompartmentItemNotFoundError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(updateCompartmentItemQuantity).mockRejectedValue(
      new CompartmentItemNotFoundError('unknown-item'),
    );

    const result = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2', itemId: 'unknown-item' }, JSON.stringify({ quantity: 1 })),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('returns 503 (fail-closed) when DynamoDB is unavailable', async () => {
    const { updateInventoryQuantity } = await import('./handler.js');
    const { updateCompartmentItemQuantity, CompartmentItemStoreUnavailableError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(updateCompartmentItemQuantity).mockRejectedValue(
      new CompartmentItemStoreUnavailableError(new Error('x')),
    );

    const result = (await updateInventoryQuantity(
      buildEvent({ unitId: 'ENGINE-2', itemId: 'CI-021' }, JSON.stringify({ quantity: 1 })),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });

  it('denies with 403 before invoking any dependency when the bearer token is missing (entrypoint test, exported handler)', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent(
        { unitId: 'ENGINE-2', itemId: 'CI-021' },
        JSON.stringify({ quantity: 1 }),
        PRINCIPAL,
        {},
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });
});
