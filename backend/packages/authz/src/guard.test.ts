import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { GuardEvent } from './guard.js';
import type { CedarPrincipalContext } from './decide.js';

const CHIEF: CedarPrincipalContext = {
  sub: 'chief-1',
  deptId: 'dept-001',
  'cognito:groups': 'chief',
};
const ADMIN: CedarPrincipalContext = {
  sub: 'admin-1',
  deptId: 'dept-001',
  'cognito:groups': 'admin',
};
const NON_PRIVILEGED: readonly CedarPrincipalContext[] = [
  { sub: 'member-1', deptId: 'dept-001', 'cognito:groups': 'member' },
  { sub: 'officer-1', deptId: 'dept-001', 'cognito:groups': 'officer' },
  { sub: 'training-1', deptId: 'dept-001', 'cognito:groups': 'training' },
  { sub: 'apparatus-1', deptId: 'dept-001', 'cognito:groups': 'apparatus' },
];

function buildEvent(
  headers: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/platform/config',
    rawPath: '/api/v1/platform/config',
    rawQueryString: '',
    headers,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
  } as unknown as GuardEvent;
}

function fakeClientDeciding(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function roleGateClient(allowedTokens: readonly string[]): VerifiedPermissionsClient {
  return {
    send: vi.fn((command: { input: { accessToken: string } }) =>
      Promise.resolve({
        decision: allowedTokens.includes(command.input.accessToken)
          ? Decision.ALLOW
          : Decision.DENY,
      }),
    ),
  } as unknown as VerifiedPermissionsClient;
}

describe('withAuthorization', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('denies a member-role principal on an admin-only action before the inner handler runs (AC1)', async () => {
    const { withAuthorization } = await import('./guard.js');
    const inner = vi.fn();
    const client = fakeClientDeciding('DENY');
    const wrapped = withAuthorization(inner, {
      actionType: 'Boxalarm::Action',
      actionId: 'UpdatePlatformConfig',
      resourceType: 'Boxalarm::Config',
      resourceId: () => 'cfg-1',
      client,
    });

    const result = await wrapped(buildEvent({ authorization: 'Bearer token' }, NON_PRIVILEGED[0]));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(inner).not.toHaveBeenCalled();
  });

  it('returns 503 and never invokes the inner handler when Verified Permissions is unavailable — never a defaulted allow (AC3, core-harm)', async () => {
    const { withAuthorization } = await import('./guard.js');
    const inner = vi.fn();
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = withAuthorization(inner, {
      actionType: 'Boxalarm::Action',
      actionId: 'ExportDepartmentData',
      resourceType: 'Boxalarm::Export',
      resourceId: () => 'export-1',
      client,
    });

    const result = await wrapped(buildEvent({ authorization: 'Bearer token' }, CHIEF));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(inner).not.toHaveBeenCalled();
  });

  it('denies (fail-closed, 401 not 503) on a missing bearer token, missing principal, or malformed principal', async () => {
    const { withAuthorization } = await import('./guard.js');
    const inner = vi.fn();
    const wrapped = withAuthorization(inner, {
      actionType: 'Boxalarm::Action',
      actionId: 'ReadPlatformConfig',
      resourceType: 'Boxalarm::Config',
      resourceId: () => 'cfg-1',
      client: fakeClientDeciding('ALLOW'),
    });

    const noToken = await wrapped(buildEvent(undefined, CHIEF));
    const noPrincipal = await wrapped(buildEvent({ authorization: 'Bearer token' }, undefined));
    const malformed = await wrapped(buildEvent({ authorization: 'Bearer token' }, { sub: 'x' }));

    expect(noToken).toMatchObject({ statusCode: 401 });
    expect(noPrincipal).toMatchObject({ statusCode: 401 });
    expect(malformed).toMatchObject({ statusCode: 401 });
    expect(inner).not.toHaveBeenCalled();
  });

  it('fires the unconditional alarm-on-invocation metric regardless of allow or deny (AC5)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { withAuthorization } = await import('./guard.js');

    const allowWrapped = withAuthorization(vi.fn().mockResolvedValue({ statusCode: 200 }), {
      actionType: 'Boxalarm::Action',
      actionId: 'ExportDepartmentData',
      resourceType: 'Boxalarm::Export',
      resourceId: () => 'export-1',
      alarmOnInvocation: 'PlatformExportInvoked',
      client: fakeClientDeciding('ALLOW'),
    });
    await allowWrapped(buildEvent({ authorization: 'Bearer token' }, CHIEF));

    const denyWrapped = withAuthorization(vi.fn(), {
      actionType: 'Boxalarm::Action',
      actionId: 'ExportDepartmentData',
      resourceType: 'Boxalarm::Export',
      resourceId: () => 'export-1',
      alarmOnInvocation: 'PlatformExportInvoked',
      client: fakeClientDeciding('DENY'),
    });
    await denyWrapped(buildEvent({ authorization: 'Bearer token' }, NON_PRIVILEGED[0]));

    const invocationLogs = logSpy.mock.calls.filter((call) =>
      (call[0] as string).includes('PlatformExportInvoked'),
    );
    expect(invocationLogs).toHaveLength(2);
    logSpy.mockRestore();
  });

  it('denies all four non-privileged personas and allows chief/admin on an export/disposal-shaped action (AC5)', async () => {
    const { withAuthorization } = await import('./guard.js');
    const client = roleGateClient(['chief-token', 'admin-token']);
    const wrapped = withAuthorization(vi.fn().mockResolvedValue({ statusCode: 200 }), {
      actionType: 'Boxalarm::Action',
      actionId: 'DisposeRecords',
      resourceType: 'Boxalarm::Records',
      resourceId: () => 'records-1',
      client,
    });

    for (const persona of NON_PRIVILEGED) {
      const result = await wrapped(
        buildEvent({ authorization: `Bearer ${persona['cognito:groups']}-token` }, persona),
      );
      expect(result).toMatchObject({ statusCode: 403 });
    }

    const chiefResult = await wrapped(buildEvent({ authorization: 'Bearer chief-token' }, CHIEF));
    const adminResult = await wrapped(buildEvent({ authorization: 'Bearer admin-token' }, ADMIN));
    expect(chiefResult).toEqual({ statusCode: 200 });
    expect(adminResult).toEqual({ statusCode: 200 });
  });

  it('never reads deptId from the request body/path/query — the VP call and any logged deptId come only from the verified authorizer principal (tenancy boundary)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { withAuthorization } = await import('./guard.js');
    const client = fakeClientDeciding('DENY');
    const wrapped = withAuthorization(vi.fn(), {
      actionType: 'Boxalarm::Action',
      actionId: 'UpdatePlatformConfig',
      resourceType: 'Boxalarm::Config',
      resourceId: () => 'cfg-1',
      client,
    });
    const event = buildEvent({ authorization: 'Bearer token' }, NON_PRIVILEGED[0]);
    // A caller-controlled deptId on the body/path/query must have zero effect — only
    // event.requestContext.authorizer.lambda.deptId (cryptographically verified by the
    // Cognito authorizer, #180) is ever a legitimate source.
    Object.assign(event, {
      body: JSON.stringify({ deptId: 'dept-injected' }),
      pathParameters: { deptId: 'dept-injected' },
      queryStringParameters: { deptId: 'dept-injected' },
    });

    await wrapped(event);

    const sentCommand = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: unknown;
    };
    expect(JSON.stringify(sentCommand.input)).not.toContain('dept-injected');
    const denialLog = logSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(denialLog).toContain(NON_PRIVILEGED[0]!.deptId);
    expect(denialLog).not.toContain('dept-injected');
    logSpy.mockRestore();
  });

  it('never logs the raw bearer token, and every denial log is exactly {event,service,reason,correlationId,deptId} — no PII', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { withAuthorization } = await import('./guard.js');
    const secretToken = 'super-secret-access-token-value-should-never-appear-in-logs';
    const wrapped = withAuthorization(vi.fn(), {
      actionType: 'Boxalarm::Action',
      actionId: 'UpdatePlatformConfig',
      resourceType: 'Boxalarm::Config',
      resourceId: () => 'cfg-1',
      client: fakeClientDeciding('DENY'),
    });

    await wrapped(buildEvent({ authorization: `Bearer ${secretToken}` }, NON_PRIVILEGED[0]));

    expect(logSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of logSpy.mock.calls) {
      const logged = JSON.parse(call[0] as string) as Record<string, unknown>;
      expect(Object.keys(logged).sort()).toEqual(
        ['correlationId', 'deptId', 'event', 'reason', 'service'].sort(),
      );
      expect(call[0] as string).not.toContain(secretToken);
    }
    logSpy.mockRestore();
  });
});

describe('withBatchAuthorization', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 503 and never invokes the inner handler — no partial list — when the client throws mid-batch', async () => {
    const { withBatchAuthorization } = await import('./guard.js');
    const inner = vi.fn();
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = withBatchAuthorization(inner, {
      actionType: 'Boxalarm::Action',
      actionId: 'ReadRosterEntry',
      resourceType: 'Boxalarm::Member',
      resourceIds: () => ['m-1', 'm-2'],
      client,
    });

    const result = await wrapped(buildEvent({ authorization: 'Bearer token' }, CHIEF));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes the allowed subset to the inner handler and makes zero VP calls for an empty resource list', async () => {
    const { withBatchAuthorization } = await import('./guard.js');
    const send = vi.fn().mockResolvedValue({
      results: [{ decision: Decision.ALLOW }, { decision: Decision.DENY }],
    });
    const client = { send } as unknown as VerifiedPermissionsClient;
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withBatchAuthorization(inner, {
      actionType: 'Boxalarm::Action',
      actionId: 'ReadRosterEntry',
      resourceType: 'Boxalarm::Member',
      resourceIds: () => ['m-1', 'm-2'],
      client,
    });

    await wrapped(buildEvent({ authorization: 'Bearer token' }, CHIEF));

    expect(send).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(expect.anything(), CHIEF, { allowedResourceIds: ['m-1'] });

    const emptySend = vi.fn();
    const emptyWrapped = withBatchAuthorization(inner, {
      actionType: 'Boxalarm::Action',
      actionId: 'ReadRosterEntry',
      resourceType: 'Boxalarm::Member',
      resourceIds: () => [],
      client: { send: emptySend } as unknown as VerifiedPermissionsClient,
    });
    await emptyWrapped(buildEvent({ authorization: 'Bearer token' }, CHIEF));
    expect(emptySend).not.toHaveBeenCalled();
  });
});
