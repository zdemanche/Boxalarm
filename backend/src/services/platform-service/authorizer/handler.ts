import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
  APIGatewaySimpleAuthorizerWithContextResult,
  Handler,
} from 'aws-lambda';
import { createVerifier, readAuthorizerConfig, verifyAccessToken } from './tokenVerifier.js';
import type { AccessTokenVerifier, VerifiedAccessToken } from './tokenVerifier.js';

export type AuthorizerContext = VerifiedAccessToken;

type AuthorizerResult =
  APIGatewaySimpleAuthorizerResult | APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext>;

let cachedVerifier: AccessTokenVerifier | undefined;

function getVerifier(env: NodeJS.ProcessEnv): AccessTokenVerifier {
  cachedVerifier ??= createVerifier(readAuthorizerConfig(env));
  return cachedVerifier;
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
            Namespace: 'Boxalarm/Authorizer',
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
    const context = await verifyAccessToken(verifier, token);
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
