import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import type { Fetcher } from 'aws-jwt-verify/https';

const USER_POOL_ID = 'us-east-1_HandlerPool1';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${USER_POOL_ID}`;
const WEB_CLIENT_ID = 'web-client-abc';
const DEPT_ID = 'dept-001';

interface TestKeyPair {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

function generateTestKeyPair(kid: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');
}

function signAccessToken(keyPair: TestKeyPair, payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: keyPair.kid };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), keyPair.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function baseAccessTokenPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'member-0012',
    token_use: 'access',
    iss: ISSUER,
    client_id: WEB_CLIENT_ID,
    exp: nowSeconds() + 3600,
    iat: nowSeconds() - 60,
    auth_time: nowSeconds() - 60,
    jti: 'jti-1',
    origin_jti: 'origin-jti-1',
    username: 'jsmith',
    scope: 'aws.cognito.signin.user.admin',
    version: 2,
    'custom:deptId': DEPT_ID,
    ...overrides,
  };
}

function jwksArrayBuffer(keyPairs: readonly TestKeyPair[]): ArrayBuffer {
  const json = JSON.stringify({ keys: keyPairs.map((pair) => pair.jwk) });
  return new TextEncoder().encode(json).buffer;
}

function buildEvent(
  headers: Record<string, string> | undefined,
): APIGatewayRequestAuthorizerEventV2 {
  return {
    version: '2.0',
    type: 'REQUEST',
    routeArn:
      'arn:aws:execute-api:us-east-1:111122223333:api-id/$default/GET/api/v1/platform/config',
    identitySource: [],
    routeKey: 'GET /api/v1/platform/config',
    rawPath: '/api/v1/platform/config',
    rawQueryString: '',
    cookies: [],
    ...(headers !== undefined ? { headers } : {}),
    requestContext: {} as APIGatewayRequestAuthorizerEventV2['requestContext'],
  };
}

function mockCreateVerifierWithFetcher(fetcher: Fetcher): void {
  vi.doMock('./tokenVerifier.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
    return {
      ...actual,
      createVerifier: (config: Parameters<typeof actual.createVerifier>[0]) =>
        actual.createVerifier(config, fetcher),
    };
  });
}

// The revocation store (M1) is a DynamoDB read; every test gets a store that answers "never
// revoked" unless it swaps readRevokedAt for something else.
let readRevokedAt: Mock<(...args: unknown[]) => Promise<number | undefined>>;

function mockRevocationStore(): void {
  readRevokedAt = vi
    .fn<(...args: unknown[]) => Promise<number | undefined>>()
    .mockResolvedValue(undefined);
  vi.doMock('./revocationStore.js', () => ({
    getAuthorizerStoreClient: () => ({}),
    readRevokedAt: (...args: unknown[]) => readRevokedAt(...args),
  }));
}

describe('handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.COGNITO_USER_POOL_ID = USER_POOL_ID;
    process.env.COGNITO_ISSUER = ISSUER;
    process.env.COGNITO_ALLOWED_CLIENT_IDS = WEB_CLIENT_ID;
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    mockRevocationStore();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./tokenVerifier.js');
    vi.doUnmock('./revocationStore.js');
    vi.restoreAllMocks();
  });

  it('denies when no Authorization header is present', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent(undefined), {} as never, () => undefined);
    expect(result).toEqual({ isAuthorized: false });
  });

  it('denies when the Authorization header has no bearer token', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ authorization: 'Bearer ' }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ isAuthorized: false });
  });

  it('denies (fail-closed) when required config env vars are absent — no default allow', async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ authorization: 'Bearer not-a-real-token' }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ isAuthorized: false });
  });

  it('denies an invalid/expired/wrong-signature token and never reaches a downstream service (core-harm)', async () => {
    const { handler } = await import('./handler.js');
    const keyPair = generateTestKeyPair('kid-1');
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ exp: nowSeconds() - 60 }));
    const result = await handler(
      buildEvent({ authorization: `Bearer ${token}` }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ isAuthorized: false });
  });

  it('allows a valid token and carries sub/deptId/cognito:groups derived from the verified token in context', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const config = { userPoolId: USER_POOL_ID, issuer: ISSUER, allowedClientIds: [WEB_CLIENT_ID] };
    const verifier = createVerifier(config);
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });

    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });

    const { handler } = await import('./handler.js');
    const token = signAccessToken(keyPair, baseAccessTokenPayload());
    const result = await handler(
      buildEvent({ authorization: `Bearer ${token}` }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({
      isAuthorized: true,
      context: { sub: 'member-0012', deptId: DEPT_ID, 'cognito:groups': '' },
    });
  });

  it('allows a token with a stale auth_time with no step-up/recency check (AC2/N5.2 post-recovery session guard)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const config = { userPoolId: USER_POOL_ID, issuer: ISSUER, allowedClientIds: [WEB_CLIENT_ID] };
    const verifier = createVerifier(config);
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });

    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });

    const { handler } = await import('./handler.js');
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ auth_time: nowSeconds() - 6000 }),
    );
    const result = await handler(
      buildEvent({ authorization: `Bearer ${token}` }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({
      isAuthorized: true,
      context: { sub: 'member-0012', deptId: DEPT_ID, 'cognito:groups': '' },
    });
  });

  it('denies (fail-closed) when the verified token has no custom:deptId claim', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const config = { userPoolId: USER_POOL_ID, issuer: ISSUER, allowedClientIds: [WEB_CLIENT_ID] };
    const verifier = createVerifier(config);
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });

    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });

    const { handler } = await import('./handler.js');
    const payload = baseAccessTokenPayload();
    delete payload['custom:deptId'];
    const token = signAccessToken(keyPair, payload);
    const result = await handler(
      buildEvent({ authorization: `Bearer ${token}` }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ isAuthorized: false });
  });

  it('emits an Authorizer business metric on allow and on deny (business-metrics obligation)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');
    await handler(buildEvent(undefined), {} as never, () => undefined);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('CloudWatchMetrics'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AuthorizerDenied'));
  });

  it('adds a Reason dimension to the deny metric so CloudWatch can distinguish deny causes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');
    await handler(buildEvent(undefined), {} as never, () => undefined);
    const metricLine = logSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('AuthorizerDenied'));
    const parsed = JSON.parse(metricLine ?? '{}') as {
      Reason?: string;
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };
    expect(parsed.Reason).toBe('MissingBearerToken');
    // Both dimension sets: the undimensioned [] keeps a plain deny-rate alarm resolvable,
    // ['Reason'] separates a JWKS outage from routine expiry. Emitting only the latter
    // makes the obvious alarm read zero.
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
  });

  it('logs a denial reason and message that distinguish an expired token from a wrong-client-id token', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const config = { userPoolId: USER_POOL_ID, issuer: ISSUER, allowedClientIds: [WEB_CLIENT_ID] };
    const verifier = createVerifier(config);
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });

    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    const expiredToken = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ exp: nowSeconds() - 60 }),
    );
    await handler(
      buildEvent({ authorization: `Bearer ${expiredToken}` }),
      {} as never,
      () => undefined,
    );
    const expiredLog = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      reason: string;
      message?: string;
      routeKey: string;
    };

    errorSpy.mockClear();
    const wrongClientToken = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ client_id: 'someone-else' }),
    );
    await handler(
      buildEvent({ authorization: `Bearer ${wrongClientToken}` }),
      {} as never,
      () => undefined,
    );
    const wrongClientLog = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { reason: string };

    expect(expiredLog.reason).toBe('JwtExpiredError');
    expect(wrongClientLog.reason).toBe('CognitoJwtInvalidClientIdError');
    expect(expiredLog.reason).not.toBe(wrongClientLog.reason);
    expect(expiredLog.reason).not.toBe('Error');
    expect(expiredLog.message).toBeTruthy();
    expect(expiredLog.routeKey).toBe('GET /api/v1/platform/config');
  });

  it('denies (fails closed, does not fail open) when the JWKS fetch rejects on a cache miss', async () => {
    const rejectingFetcher: Fetcher = {
      fetch: () => Promise.reject(new Error('JWKS endpoint unreachable')),
    };
    mockCreateVerifierWithFetcher(rejectingFetcher);

    const { handler } = await import('./handler.js');
    const keyPair = generateTestKeyPair('kid-1');
    const token = signAccessToken(keyPair, baseAccessTokenPayload());
    const result = await handler(
      buildEvent({ authorization: `Bearer ${token}` }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ isAuthorized: false });
  });

  it('allows a token 59m59s into its 1h lifetime — no idle-age check exists on top of exp (AC2)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const config = { userPoolId: USER_POOL_ID, issuer: ISSUER, allowedClientIds: [WEB_CLIENT_ID] };
    const verifier = createVerifier(config);
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });

    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });

    const { handler } = await import('./handler.js');
    const issuedAt = nowSeconds() - (60 * 59 + 59);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ iat: issuedAt, auth_time: issuedAt, exp: issuedAt + 3600 }),
    );
    const result = await handler(
      buildEvent({ authorization: `Bearer ${token}` }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ isAuthorized: true });
  });

  it('produces an identical isAuthorized/context shape for a valid token regardless of routeKey — no route ever adds a second gate (AC3)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const config = { userPoolId: USER_POOL_ID, issuer: ISSUER, allowedClientIds: [WEB_CLIENT_ID] };
    const verifier = createVerifier(config);
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });

    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });

    const { handler } = await import('./handler.js');
    const token = signAccessToken(keyPair, baseAccessTokenPayload());
    const routeKeys = [
      'GET /api/v1/platform/config',
      'PUT /api/v1/platform/config',
      'POST /api/v1/platform/export',
      'POST /api/v1/platform/sessions/revoke',
    ];

    const results = [];
    for (const routeKey of routeKeys) {
      results.push(
        await handler(
          { ...buildEvent({ authorization: `Bearer ${token}` }), routeKey },
          {} as never,
          () => undefined,
        ),
      );
    }

    for (const result of results) {
      expect(result).toEqual(results[0]);
      expect(result).toEqual({
        isAuthorized: true,
        context: { sub: 'member-0012', deptId: DEPT_ID, 'cognito:groups': '' },
      });
    }
  });

  it('constructs the verifier once and reuses its JWKS cache across invocations (exactly one fetch)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const fetchCalls: string[] = [];
    const fetcher: Fetcher = {
      fetch: (uri) => {
        fetchCalls.push(uri);
        return Promise.resolve(jwksArrayBuffer([keyPair]));
      },
    };
    mockCreateVerifierWithFetcher(fetcher);

    const { handler } = await import('./handler.js');
    const token = signAccessToken(keyPair, baseAccessTokenPayload());
    await handler(buildEvent({ authorization: `Bearer ${token}` }), {} as never, () => undefined);
    await handler(buildEvent({ authorization: `Bearer ${token}` }), {} as never, () => undefined);

    expect(fetchCalls).toHaveLength(1);
  });
});

describe('handler: server-side revocation check (M1)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.COGNITO_USER_POOL_ID = USER_POOL_ID;
    process.env.COGNITO_ISSUER = ISSUER;
    process.env.COGNITO_ALLOWED_CLIENT_IDS = WEB_CLIENT_ID;
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    mockRevocationStore();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./tokenVerifier.js');
    vi.doUnmock('./revocationStore.js');
    vi.restoreAllMocks();
  });

  async function loadWithKey(): Promise<{
    handler: (typeof import('./handler.js'))['handler'];
    keyPair: TestKeyPair;
  }> {
    const keyPair = generateTestKeyPair('kid-1');
    const { createVerifier } = await import('./tokenVerifier.js');
    const verifier = createVerifier({
      userPoolId: USER_POOL_ID,
      issuer: ISSUER,
      allowedClientIds: [WEB_CLIENT_ID],
    });
    verifier.cacheJwks({ keys: [keyPair.jwk as never] });
    vi.resetModules();
    vi.doMock('./tokenVerifier.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./tokenVerifier.js')>();
      return { ...actual, createVerifier: () => verifier };
    });
    const { handler } = await import('./handler.js');
    return { handler, keyPair };
  }

  function eventFor(token: string, routeKey: string): APIGatewayRequestAuthorizerEventV2 {
    return { ...buildEvent({ authorization: `Bearer ${token}` }), routeKey };
  }

  it('denies a still-unexpired access token issued before the member was revoked', async () => {
    const { handler, keyPair } = await loadWithKey();
    const issuedAt = nowSeconds() - 600;
    readRevokedAt.mockResolvedValue(nowSeconds() - 60);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ iat: issuedAt }));

    const result = await handler(
      eventFor(token, 'GET /api/v1/personnel/members'),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ isAuthorized: false });
    expect(readRevokedAt).toHaveBeenCalledWith({}, 'platform-table', DEPT_ID, 'member-0012');
  });

  it('denies a revoked token on the alerting respond route too - revocation is not an outage', async () => {
    const { handler, keyPair } = await loadWithKey();
    readRevokedAt.mockResolvedValue(nowSeconds());
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ iat: nowSeconds() - 30 }));

    const result = await handler(
      eventFor(token, 'POST /api/v1/alerting/dispatches/{dispatchId}/responses'),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ isAuthorized: false });
  });

  it('allows a token minted after the revocation (a re-enabled member, or another device after refresh)', async () => {
    const { handler, keyPair } = await loadWithKey();
    readRevokedAt.mockResolvedValue(nowSeconds() - 600);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ iat: nowSeconds() - 5 }));

    const result = await handler(
      eventFor(token, 'GET /api/v1/personnel/members'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ isAuthorized: true });
  });

  it('FAILS OPEN on an alerting read/respond route when the store cannot be read', async () => {
    const { handler, keyPair } = await loadWithKey();
    readRevokedAt.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const token = signAccessToken(keyPair, baseAccessTokenPayload());

    const result = await handler(
      eventFor(token, 'POST /api/v1/alerting/dispatches/{dispatchId}/responses'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ isAuthorized: true, context: { sub: 'member-0012' } });
  });

  it.each([
    'POST /api/v1/alerting/dispatches',
    'POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance',
    'POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger',
    'POST /api/v1/apparatus/riding-board/{dispatchId}/assignments',
    'POST /api/v1/personnel/members/{memberId}/push-tokens',
  ])(
    'FAILS OPEN on the alerting-plane route %s and emits the RevocationCheckFailOpen metric',
    async (routeKey) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { handler, keyPair } = await loadWithKey();
      readRevokedAt.mockRejectedValue(new Error('TimeoutError'));
      const token = signAccessToken(keyPair, baseAccessTokenPayload());

      const result = await handler(eventFor(token, routeKey), {} as never, () => undefined);

      expect(result).toMatchObject({ isAuthorized: true });
      const metric = logSpy.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes('"RevocationCheckFailOpen":1'));
      expect(metric).toBeDefined();
    },
  );

  it('FAILS OPEN on any route when running as the alerting authorizer', async () => {
    process.env.REVOCATION_CHECK_FAIL_OPEN = 'true';
    const { handler, keyPair } = await loadWithKey();
    readRevokedAt.mockRejectedValue(new Error('down'));
    const token = signAccessToken(keyPair, baseAccessTokenPayload());

    const result = await handler(
      eventFor(token, 'GET /api/v1/alerting/delivery-baseline'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ isAuthorized: true });
  });

  it('FAILS CLOSED on every other route when the store cannot be read', async () => {
    const { handler, keyPair } = await loadWithKey();
    readRevokedAt.mockRejectedValue(new Error('timeout'));
    const token = signAccessToken(keyPair, baseAccessTokenPayload());

    for (const routeKey of ['GET /api/v1/personnel/members', 'POST /api/v1/platform/export']) {
      const result = await handler(eventFor(token, routeKey), {} as never, () => undefined);
      expect(result, routeKey).toEqual({ isAuthorized: false });
    }
  });

  it('reads the store once per member per cache window, not once per request', async () => {
    const { handler, keyPair } = await loadWithKey();
    const token = signAccessToken(keyPair, baseAccessTokenPayload());

    for (let i = 0; i < 3; i += 1) {
      await handler(eventFor(token, 'GET /api/v1/personnel/members'), {} as never, () => undefined);
    }

    expect(readRevokedAt).toHaveBeenCalledTimes(1);
  });
});
