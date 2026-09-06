import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import type { Fetcher } from 'aws-jwt-verify/https';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import type { VerifiedPrincipal } from '@boxalarm/dept-scope';

export interface AuthorizerConfig {
  readonly userPoolId: string;
  readonly issuer: string;
  readonly allowedClientIds: readonly string[];
}

export function readAuthorizerConfig(env: NodeJS.ProcessEnv): AuthorizerConfig {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  const issuer = env.COGNITO_ISSUER;
  const allowedClientIdsRaw = env.COGNITO_ALLOWED_CLIENT_IDS;

  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID is required and was not set');
  }
  if (!issuer) {
    throw new Error('COGNITO_ISSUER is required and was not set');
  }
  if (!allowedClientIdsRaw) {
    throw new Error('COGNITO_ALLOWED_CLIENT_IDS is required and was not set');
  }

  const allowedClientIds = allowedClientIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (allowedClientIds.length === 0) {
    throw new Error('COGNITO_ALLOWED_CLIENT_IDS must list at least one client id');
  }

  const derivedIssuer = CognitoJwtVerifier.parseUserPoolId(userPoolId).issuer;
  if (derivedIssuer !== issuer) {
    throw new Error(
      `COGNITO_ISSUER "${issuer}" does not match the issuer derived from COGNITO_USER_POOL_ID ("${derivedIssuer}")`,
    );
  }

  return { userPoolId, issuer, allowedClientIds };
}

export type AccessTokenVerifier = CognitoJwtVerifierSingleUserPool<{
  userPoolId: string;
  tokenUse: 'access';
  clientId: string[];
}>;

export function createVerifier(config: AuthorizerConfig, fetcher?: Fetcher): AccessTokenVerifier {
  const verifierProps = {
    userPoolId: config.userPoolId,
    tokenUse: 'access' as const,
    clientId: [...config.allowedClientIds],
  };
  // fetcher: JWKS-cache test seam only — production callers omit it and get the library's own cache
  return fetcher
    ? CognitoJwtVerifier.create(verifierProps, { jwksCache: new SimpleJwksCache({ fetcher }) })
    : CognitoJwtVerifier.create(verifierProps);
}

export interface VerifiedAccessToken extends VerifiedPrincipal {
  readonly sub: string;
  readonly deptId: string;
  readonly 'cognito:groups': string;
}

// Authorizer context values must be strings, so groups are joined on a single space.
// Safe as a delimiter: Cognito GroupName forbids whitespace, so a group name can never
// contain the separator and forge an extra group. Consumers (E8-S3 Cedar) split on ' '
// and MUST treat '' as zero groups, not ['']".
function normalizeGroups(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === 'string').join(' ');
  }
  return typeof raw === 'string' ? raw : '';
}

export async function verifyAccessToken(
  verifier: AccessTokenVerifier,
  token: string,
): Promise<VerifiedAccessToken> {
  const payload = await verifier.verify(token);
  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
    throw new Error('sub claim is required and was empty');
  }
  // Tenancy boundary. deptId is read ONLY from the cryptographically verified payload —
  // never from a header, body, query or path parameter. Whitespace-only is rejected: it
  // survives a length check and would become the partition key `DEPT#   `.
  // E8-S1-INFRA MUST exclude custom:deptId from both app clients' WriteAttributes
  // (boxalarm-docs#115) — Cognito defaults custom attributes to writable, and the access
  // token carries aws.cognito.signin.user.admin, so a member could otherwise self-write
  // deptId and hold a validly-signed token for another department.
  const deptId = payload['custom:deptId'];
  if (typeof deptId !== 'string' || deptId.trim().length === 0) {
    throw new Error('custom:deptId claim is required and was not present on the verified token');
  }
  return {
    sub: payload.sub,
    deptId,
    'cognito:groups': normalizeGroups(payload['cognito:groups']),
  };
}
