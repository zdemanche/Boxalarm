import type { IncidentEvent } from './authContext.js';

/** Test-only builder for an HTTP API v2 event carrying the shared authorizer's context. */
export function buildIncidentEvent(options: {
  readonly method: string;
  readonly routeKey: string;
  readonly auth?: Record<string, unknown>;
  readonly incidentId?: string;
  readonly body?: unknown;
  readonly query?: Record<string, string>;
}): IncidentEvent {
  const path = options.routeKey.split(' ')[1]!.replace('{incidentId}', options.incidentId ?? '');
  return {
    version: '2.0',
    routeKey: options.routeKey,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token' },
    queryStringParameters: options.query,
    pathParameters: options.incidentId !== undefined ? { incidentId: options.incidentId } : {},
    isBase64Encoded: false,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: options.method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: options.routeKey,
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: options.auth !== undefined ? { lambda: options.auth } : undefined,
    },
  } as unknown as IncidentEvent;
}

export const OFFICER_AUTH = { sub: 'MBR-0034', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' };
export const CHIEF_AUTH = { sub: 'MBR-0001', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' };
export const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

/** The deployed NERIS tiers (infrastructure cedar-policies.ts) for the actions faked below. */
const NERIS_OFFICER_TIER_ACTIONS = new Set([
  'CreateIncidentReport',
  'SubmitIncidentReport',
  'RetryIncidentSubmission',
  'ViewIncidentSubmission',
  'RecordExposureForOthers',
]);
const NERIS_OFFICER_GROUPS = new Set(['OFFICER', 'CHIEF', 'ADMIN']);

/**
 * The bearer token a test event carries: the caller's groups, so a fake Verified Permissions
 * client (fakeCedarDecision) can decide as the deployed policies would for that caller.
 */
export function bearerFor(auth: Record<string, unknown> | undefined): Record<string, string> {
  const groups = typeof auth?.['cognito:groups'] === 'string' ? auth['cognito:groups'] : '';
  return auth === undefined ? {} : { authorization: `Bearer ${groups.replace(/ /g, ',') || '-'}` };
}

/** IsAuthorizedWithToken as the deployed NERIS tiers answer it for a bearerFor token. */
export function fakeCedarDecision(command: {
  readonly input: {
    readonly accessToken?: string;
    readonly action?: { readonly actionId?: string };
  };
}): Promise<{ decision: 'ALLOW' | 'DENY' }> {
  const groups = (command.input.accessToken ?? '').split(',');
  const actionId = command.input.action?.actionId ?? '';
  const allowed = NERIS_OFFICER_TIER_ACTIONS.has(actionId)
    ? groups.some((group) => NERIS_OFFICER_GROUPS.has(group))
    : true;
  return Promise.resolve({ decision: allowed ? 'ALLOW' : 'DENY' });
}
