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
    routeKey: 'POST /api/v1/apparatus/{unitId}/inventory',
    rawPath: '/api/v1/apparatus/ENGINE-2/inventory',
    rawQueryString: '',
    headers,
    pathParameters,
    body,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

vi.mock('../inventory/compartmentItemRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inventory/compartmentItemRepository.js')>();
  return { ...actual, putCompartmentItem: vi.fn() };
});

describe('inventory-create handler', () => {
  const originalEnv = { ...process.env };
  const VALID_BODY = JSON.stringify({ compartmentCode: 'C1', itemName: 'Halligan', quantity: 2 });

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('returns 201 with the created item on a valid body (AC1)', async () => {
    const { createInventoryItem } = await import('./handler.js');
    const { putCompartmentItem } = await import('../inventory/compartmentItemRepository.js');
    vi.mocked(putCompartmentItem).mockResolvedValue({
      itemId: 'CI-021',
      compartmentCode: 'C1',
      itemName: 'Halligan',
      quantity: 2,
    });

    const result = (await createInventoryItem(
      buildEvent({ unitId: 'ENGINE-2' }, VALID_BODY),
      PRINCIPAL,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body)).toEqual({
      itemId: 'CI-021',
      compartmentCode: 'C1',
      itemName: 'Halligan',
      quantity: 2,
    });
    expect(vi.mocked(putCompartmentItem)).toHaveBeenCalledWith(
      expect.anything(),
      'platform-service',
      'dept-001',
      'ENGINE-2',
      { compartmentCode: 'C1', itemName: 'Halligan', quantity: 2 },
      'officer-1',
    );
  });

  it('returns 400 when the unitId path parameter is absent', async () => {
    const { createInventoryItem } = await import('./handler.js');
    const result = (await createInventoryItem(buildEvent(undefined, VALID_BODY), PRINCIPAL)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for an absent body', async () => {
    const { createInventoryItem } = await import('./handler.js');
    const result = (await createInventoryItem(
      buildEvent({ unitId: 'ENGINE-2' }, undefined),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it.each([
    ['empty compartmentCode', { compartmentCode: '', itemName: 'x', quantity: 1 }],
    ['empty itemName', { compartmentCode: 'C1', itemName: '', quantity: 1 }],
    ['string-typed quantity', { compartmentCode: 'C1', itemName: 'x', quantity: '5' }],
    ['negative quantity', { compartmentCode: 'C1', itemName: 'x', quantity: -1 }],
    ['non-integer quantity', { compartmentCode: 'C1', itemName: 'x', quantity: 1.5 }],
  ])('returns 400 for %s', async (_label, body) => {
    const { createInventoryItem } = await import('./handler.js');
    const result = (await createInventoryItem(
      buildEvent({ unitId: 'ENGINE-2' }, JSON.stringify(body)),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when unitId contains the pk delimiter (#-bearing path parameter row)', async () => {
    const { createInventoryItem } = await import('./handler.js');
    const { putCompartmentItem, CompartmentItemInvalidKeyError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(putCompartmentItem).mockRejectedValue(
      new CompartmentItemInvalidKeyError('unitId', 'EN#G'),
    );

    const result = (await createInventoryItem(
      buildEvent({ unitId: 'EN#G' }, VALID_BODY),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when the principal deptId contains the pk delimiter, without invoking the repository', async () => {
    const { createInventoryItem } = await import('./handler.js');
    const { putCompartmentItem } = await import('../inventory/compartmentItemRepository.js');
    const result = (await createInventoryItem(
      buildEvent({ unitId: 'ENGINE-2' }, VALID_BODY, { ...PRINCIPAL, deptId: 'DEPT#1' }),
      { ...PRINCIPAL, deptId: 'DEPT#1' },
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(vi.mocked(putCompartmentItem)).not.toHaveBeenCalled();
  });

  it('returns 503 (fail-closed) when DynamoDB is unavailable', async () => {
    const { createInventoryItem } = await import('./handler.js');
    const { putCompartmentItem, CompartmentItemStoreUnavailableError } =
      await import('../inventory/compartmentItemRepository.js');
    vi.mocked(putCompartmentItem).mockRejectedValue(
      new CompartmentItemStoreUnavailableError(new Error('x')),
    );

    const result = (await createInventoryItem(
      buildEvent({ unitId: 'ENGINE-2' }, VALID_BODY),
      PRINCIPAL,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });

  it('denies with 403 before invoking any dependency when the bearer token is missing (entrypoint test, exported handler)', async () => {
    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent({ unitId: 'ENGINE-2' }, VALID_BODY, PRINCIPAL, {}),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });
});
