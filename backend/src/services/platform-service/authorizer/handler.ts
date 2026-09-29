import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
  APIGatewaySimpleAuthorizerWithContextResult,
  Handler,
} from 'aws-lambda';
import { createVerifier, readAuthorizerConfig, verifyAccessTokenClaims } from './tokenVerifier.js';
import type { AccessTokenVerifier, VerifiedAccessToken } from './tokenVerifier.js';
import { createRevocationChecker, FAIL_OPEN_ROUTE_KEYS } from './revocationCheck.js';
import type { RevocationChecker } from './revocationCheck.js';
import { getAuthorizerStoreClient, readRevokedAt } from './revocationStore.js';

export type AuthorizerContext = VerifiedAccessToken;

type AuthorizerResult =
  APIGatewaySimpleAuthorizerResult | APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext>;

let cachedVerifier: AccessTokenVerifier | undefined;

function getVerifier(env: NodeJS.ProcessEnv): AccessTokenVerifier {
  cachedVerifier ??= createVerifier(readAuthorizerConfig(env));
  return cachedVerifier;
}

let cachedChecker: RevocationChecker | undefined;

function getRevocationChecker(env: NodeJS.ProcessEnv): RevocationChecker {
  if (!cachedChecker) {
    const tableName = env.PLATFORM_TABLE_NAME;
    if (!tableName) {
      throw new Error('PLATFORM_TABLE_NAME is required and was not set');
    }
    cachedChecker = createRevocationChecker((deptId, sub) =>
      readRevokedAt(getAuthorizerStoreClient(), tableName, deptId, sub),
    );
  }
  return cachedChecker;
}

function extractBearerToken(event: APIGatewayRequestAuthorizerEventV2): string | undefined {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }
  return token;
}

function emitAuthorizerMetric(outcome: 'Allowed' | 'Denied', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/authorizer',
            // Both dimension sets on a deny: [] so a plain deny-rate alarm resolves, and
            // ['Reason'] so an outage is separable from routine expiry. Emitting only the
            // dimensioned variant makes the obvious alarm read zero.
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `Authorizer${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`Authorizer${outcome}`]: 1,
    }),
  );
}

export const handler: Handler<APIGatewayRequestAuthorizerEventV2, AuthorizerResult> = async (
  event,
) => {
  const token = extractBearerToken(event);
  if (!token) {
    emitAuthorizerMetric('Denied', 'MissingBearerToken');
    return { isAuthorized: false };
  }

  try {
    const verifier = getVerifier(process.env);
    const checker = getRevocationChecker(process.env);
    const { principal: context, issuedAt } = await verifyAccessTokenClaims(verifier, token);

    // M1: an access token is verified offline and lives an hour; a revoked member's token
    // must stop working now. See revocationCheck.ts for the cache and the fail-open rule.
    const revocation = await checker.check({ deptId: context.deptId, sub: context.sub, issuedAt });
    if (revocation === 'revoked') {
      console.error(
        JSON.stringify({
          event: 'authorizer.denied',
          reason: 'SessionRevoked',
          routeKey: event.routeKey,
        }),
      );
      emitAuthorizerMetric('Denied', 'SessionRevoked');
      return { isAuthorized: false };
    }
    if (revocation === 'unavailable') {
      const failOpen = FAIL_OPEN_ROUTE_KEYS.has(event.routeKey);
      console.error(
        JSON.stringify({
          event: failOpen ? 'authorizer.revocationCheck.failOpen' : 'authorizer.denied',
          reason: 'RevocationStoreUnavailable',
          routeKey: event.routeKey,
        }),
      );
      if (!failOpen) {
        emitAuthorizerMetric('Denied', 'RevocationStoreUnavailable');
        return { isAuthorized: false };
      }
      emitAuthorizerMetric('Allowed', 'RevocationCheckFailOpen');
      return { isAuthorized: true, context };
    }
    emitAuthorizerMetric('Allowed');
    return { isAuthorized: true, context };
  } catch (error) {
    // constructor.name is what separates a JWKS outage (NonRetryableFetchError/FetchError)
    // from routine expiry (JwtExpiredError) — aws-jwt-verify does not set .name.
    // Bundling MUST keep class names: esbuild --minify requires --keep-names, or every
    // reason collapses to a mangled identifier and this distinction is silently lost.
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    console.error(
      JSON.stringify({
        event: 'authorizer.denied',
        reason,
        message: error instanceof Error ? error.message : undefined,
        routeKey: event.routeKey,
      }),
    );
    emitAuthorizerMetric('Denied', reason);
    return { isAuthorized: false };
  }
};
