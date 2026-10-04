import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';

function buildEvent(
  memberId: string | undefined,
  deptId = 'dept-001',
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/platform/sessions/{memberId}/devices',
    rawPath: `/api/v1/platform/sessions/${memberId ?? ''}/devices`,
    rawQueryString: '',
    headers: {},
    ...(memberId !== undefined ? { pathParameters: { memberId } } : {}),
    isBase64Encoded: false,
    requestContext: {
      http: { method: 'GET' },
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'admin-1', deptId, 'cognito:groups': 'CHIEF' } },
    },
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

describe('listDevicesHandler', () => {
  let listMemberDevices: Mock<(...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    vi.resetModules();
    listMemberDevices = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([
      { deviceId: 'install-tablet', platform: 'FCM', registeredAt: 2, valid: true },
      { deviceId: 'install-phone', platform: 'APNS', registeredAt: 1, valid: true },
    ]);
    vi.doMock('./memberAccessStore.js', () => ({
      readPlatformTableName: () => 'platform-table',
      getAccessStoreClient: () => ({}),
      listMemberDevices: (...args: unknown[]) => listMemberDevices(...args),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return {
        ...actual,
        withAuthorization:
          (inner: (event: unknown, principal: unknown) => unknown) =>
          (event: { requestContext: { authorizer: { lambda: unknown } } }) =>
            inner(event, event.requestContext.authorizer.lambda),
      };
    });
  });

  afterEach(() => {
    vi.doUnmock('./memberAccessStore.js');
    vi.doUnmock('@boxalarm/authz');
    vi.restoreAllMocks();
  });

  it('is gated by the Cedar ViewMemberDevices action on the member', async () => {
    const withAuthorization = vi.fn<
      (inner: unknown, options: { resourceId: (event: unknown) => string }) => unknown
    >((inner) => inner);
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization };
    });
    await import('./listDevicesHandler.js');

    expect(withAuthorization).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        actionType: 'Boxalarm::Action',
        actionId: 'ViewMemberDevices',
        resourceType: 'Boxalarm::Member',
      }),
    );
    const options = withAuthorization.mock.calls[0]?.[1];
    expect(options?.resourceId(buildEvent('mbr-102'))).toBe('mbr-102');
  });

  it("lists the member's devices from the caller's department", async () => {
    const { handler } = await import('./listDevicesHandler.js');

    const result = (await handler(buildEvent('mbr-102'))) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({
      memberId: 'mbr-102',
      devices: [
        { deviceId: 'install-tablet', platform: 'FCM', registeredAt: 2, valid: true },
        { deviceId: 'install-phone', platform: 'APNS', registeredAt: 1, valid: true },
      ],
    });
    expect(listMemberDevices).toHaveBeenCalledWith({}, 'platform-table', 'dept-001', 'mbr-102');
  });

  it('answers 404 when there is no such member in the department', async () => {
    listMemberDevices.mockResolvedValue(undefined);
    const { handler } = await import('./listDevicesHandler.js');

    const result = (await handler(buildEvent('mbr-ghost'))) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
  });

  it('answers 400 without a memberId', async () => {
    const { handler } = await import('./listDevicesHandler.js');

    const result = (await handler(buildEvent(undefined))) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(listMemberDevices).not.toHaveBeenCalled();
  });

  it('answers 503 with a traceId when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listMemberDevices.mockRejectedValue(new Error('dynamo down'));
    const { handler } = await import('./listDevicesHandler.js');

    const result = (await handler(buildEvent('mbr-102'))) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(503);
    expect((JSON.parse(result.body as string) as { traceId?: string }).traceId).toBeTruthy();
  });
});
