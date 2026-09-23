import { describe, expect, it } from 'vitest';
import { readAuthorizerContext } from './authContext.js';
import type { ApparatusEvent } from './authContext.js';

function buildEvent(lambdaContext: Record<string, unknown> | undefined): ApparatusEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus',
    rawPath: '/api/v1/apparatus',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/api/v1/apparatus',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/apparatus',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as ApparatusEvent;
}

describe('readAuthorizerContext', () => {
  it('throws (fail-closed) when the authorizer context is entirely absent', () => {
    expect(() => readAuthorizerContext(buildEvent(undefined))).toThrow();
  });

  it('throws (fail-closed) when deptId is missing on the verified authorizer context', () => {
    expect(() =>
      readAuthorizerContext(buildEvent({ sub: 'member-1', 'cognito:groups': '' })),
    ).toThrow(/deptId/);
  });

  it('throws (fail-closed) when deptId is an empty string', () => {
    expect(() =>
      readAuthorizerContext(buildEvent({ sub: 'member-1', deptId: '', 'cognito:groups': '' })),
    ).toThrow(/deptId/);
  });

  it('reads deptId only from the verified authorizer context, never body/query/path (core-harm)', () => {
    const result = readAuthorizerContext(
      buildEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }),
    );
    expect(result.deptId).toBe('NICHOLS');
  });

  it('treats ADMIN as an admin group', () => {
    const result = readAuthorizerContext(
      buildEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER ADMIN' }),
    );
    expect(result.isAdmin).toBe(true);
  });

  it('treats CHIEF as an admin group', () => {
    const result = readAuthorizerContext(
      buildEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' }),
    );
    expect(result.isAdmin).toBe(true);
  });

  it('is not admin for a plain MEMBER group', () => {
    const result = readAuthorizerContext(
      buildEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' }),
    );
    expect(result.isAdmin).toBe(false);
  });

  it('is not admin when cognito:groups is empty', () => {
    const result = readAuthorizerContext(
      buildEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }),
    );
    expect(result.isAdmin).toBe(false);
  });
});
