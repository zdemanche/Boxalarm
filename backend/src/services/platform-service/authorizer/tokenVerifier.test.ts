import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Fetcher } from 'aws-jwt-verify/https';
import {
  CognitoJwtInvalidClientIdError,
  JwtExpiredError,
  JwtInvalidSignatureError,
  KidNotFoundInJwksError,
  ParameterValidationError,
} from 'aws-jwt-verify/error';
import { createVerifier, readAuthorizerConfig, verifyAccessToken } from './tokenVerifier.js';

const USER_POOL_ID = 'us-east-1_TestPool1';
const OTHER_USER_POOL_ID = 'us-east-1_OtherPool2';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${USER_POOL_ID}`;
const WEB_CLIENT_ID = 'web-client-abc';
const NATIVE_CLIENT_ID = 'native-client-def';
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

function buildVerifier(keyPair: TestKeyPair) {
  const config = {
    userPoolId: USER_POOL_ID,
    issuer: ISSUER,
    allowedClientIds: [WEB_CLIENT_ID, NATIVE_CLIENT_ID],
  };
  const verifier = createVerifier(config);
  verifier.cacheJwks({ keys: [keyPair.jwk as never] });
  return verifier;
}

describe('readAuthorizerConfig', () => {
  const validEnv = {
    COGNITO_USER_POOL_ID: USER_POOL_ID,
    COGNITO_ISSUER: ISSUER,
    COGNITO_ALLOWED_CLIENT_IDS: `${WEB_CLIENT_ID},${NATIVE_CLIENT_ID}`,
  };

  it('reads and parses the three pinned env vars', () => {
    const config = readAuthorizerConfig(validEnv);
    expect(config).toEqual({
      userPoolId: USER_POOL_ID,
      issuer: ISSUER,
      allowedClientIds: [WEB_CLIENT_ID, NATIVE_CLIENT_ID],
    });
  });

  it('throws when COGNITO_USER_POOL_ID is missing (empty/absent-input row)', () => {
    expect(() => readAuthorizerConfig({ ...validEnv, COGNITO_USER_POOL_ID: undefined })).toThrow(
      'COGNITO_USER_POOL_ID is required',
    );
  });

  it('throws when COGNITO_ISSUER is missing', () => {
    expect(() => readAuthorizerConfig({ ...validEnv, COGNITO_ISSUER: undefined })).toThrow(
      'COGNITO_ISSUER is required',
    );
  });

  it('throws when COGNITO_ALLOWED_CLIENT_IDS is missing', () => {
    expect(() =>
      readAuthorizerConfig({ ...validEnv, COGNITO_ALLOWED_CLIENT_IDS: undefined }),
    ).toThrow('COGNITO_ALLOWED_CLIENT_IDS is required');
  });

  it('throws when COGNITO_ISSUER does not match the issuer derived from the pool id', () => {
    expect(() =>
      readAuthorizerConfig({
        ...validEnv,
        COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/wrong',
      }),
    ).toThrow('does not match the issuer derived from COGNITO_USER_POOL_ID');
  });
});

describe('verifyAccessToken', () => {
  it('accepts a well-formed token signed for the web client id', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ client_id: WEB_CLIENT_ID }));
    await expect(verifyAccessToken(verifier, token)).resolves.toEqual({
      sub: 'member-0012',
      deptId: DEPT_ID,
      'cognito:groups': '',
    });
  });

  it('accepts a well-formed token signed for the native client id (AC2)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ client_id: NATIVE_CLIENT_ID }));
    await expect(verifyAccessToken(verifier, token)).resolves.toEqual({
      sub: 'member-0012',
      deptId: DEPT_ID,
      'cognito:groups': '',
    });
  });

  it('denies an expired token with the specific expiry error', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ exp: nowSeconds() - 60 }));
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(JwtExpiredError);
  });

  it('denies a token presented more than 1 hour after issuance — the exact 1h00m01s boundary (AC4)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const issuedAt = nowSeconds() - (3600 + 1);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ iat: issuedAt, auth_time: issuedAt, exp: issuedAt + 3600 }),
    );
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(JwtExpiredError);
  });

  it('denies a token with a bad signature with the specific signature error', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const wrongSigner = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(wrongSigner, baseAccessTokenPayload());
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(JwtInvalidSignatureError);
  });

  it('denies a token whose kid is unknown to the cached JWKS, fetching (not failing open) on the cache miss', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const unknownKidSigner = generateTestKeyPair('kid-unknown');
    const config = {
      userPoolId: USER_POOL_ID,
      issuer: ISSUER,
      allowedClientIds: [WEB_CLIENT_ID, NATIVE_CLIENT_ID],
    };
    const fetcher: Fetcher = { fetch: () => Promise.resolve(jwksArrayBuffer([keyPair])) };
    const verifier = createVerifier(config, fetcher);
    const token = signAccessToken(unknownKidSigner, baseAccessTokenPayload());
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(KidNotFoundInJwksError);
  });

  it('denies a token whose client_id is not in the allow list with the specific client-id error', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ client_id: 'some-other-client' }),
    );
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(
      CognitoJwtInvalidClientIdError,
    );
  });

  it('denies a token carrying only aud with no matching client_id claim (specific client-id error)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const payload = baseAccessTokenPayload();
    delete payload.client_id;
    const token = signAccessToken(keyPair, { ...payload, aud: WEB_CLIENT_ID });
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(
      CognitoJwtInvalidClientIdError,
    );
  });

  it('denies a token issued by a different pool (unconfigured-issuer error)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({
        iss: `https://cognito-idp.us-east-1.amazonaws.com/${OTHER_USER_POOL_ID}`,
      }),
    );
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(ParameterValidationError);
  });

  it('accepts a token with no amr/MFA claim and a one-hour-old auth_time (N5.2 negative test)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ auth_time: nowSeconds() - 3600 }),
    );
    await expect(verifyAccessToken(verifier, token)).resolves.toEqual({
      sub: 'member-0012',
      deptId: DEPT_ID,
      'cognito:groups': '',
    });
  });

  it('denies a token with an empty sub claim (trust-boundary guard)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ sub: '' }));
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow('sub claim is required');
  });

  it('denies when custom:deptId is absent from the verified payload (fail-closed tenancy boundary)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const payload = baseAccessTokenPayload();
    delete payload['custom:deptId'];
    const token = signAccessToken(keyPair, payload);
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(
      'custom:deptId claim is required',
    );
  });

  it('denies when custom:deptId is an empty string', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ 'custom:deptId': '' }));
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(
      'custom:deptId claim is required',
    );
  });

  it('denies when custom:deptId is whitespace only (it would become the partition key `DEPT#   `)', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ 'custom:deptId': '   ' }));
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow(
      'custom:deptId claim is required',
    );
  });

  it('denies when sub is whitespace only', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ sub: '   ' }));
    await expect(verifyAccessToken(verifier, token)).rejects.toThrow('sub claim is required');
  });

  it('returns deptId read from the verified custom:deptId claim, derived server-side', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(keyPair, baseAccessTokenPayload({ 'custom:deptId': 'dept-042' }));
    await expect(verifyAccessToken(verifier, token)).resolves.toMatchObject({ deptId: 'dept-042' });
  });

  it('normalizes an array-valued cognito:groups claim into a stable serialized string', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ 'cognito:groups': ['chief', 'officer'] }),
    );
    await expect(verifyAccessToken(verifier, token)).resolves.toMatchObject({
      'cognito:groups': 'chief officer',
    });
  });

  it('passes through a space-delimited string-valued cognito:groups claim unchanged', async () => {
    const keyPair = generateTestKeyPair('kid-1');
    const verifier = buildVerifier(keyPair);
    const token = signAccessToken(
      keyPair,
      baseAccessTokenPayload({ 'cognito:groups': 'chief officer' }),
    );
    await expect(verifyAccessToken(verifier, token)).resolves.toMatchObject({
      'cognito:groups': 'chief officer',
    });
  });
});
