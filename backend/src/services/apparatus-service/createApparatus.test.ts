import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApparatusEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
): ApparatusEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus',
    rawPath: '/api/v1/apparatus',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/api/v1/apparatus',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/apparatus',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as ApparatusEvent;
}

const ADMIN_AUTH_CONTEXT = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };
const MEMBER_AUTH_CONTEXT = { sub: 'member-2', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

describe('createApparatus handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./apparatusRepository.js');
    vi.restoreAllMocks();
  });

  it('returns 201 with status defaulted to IN_SERVICE when status is omitted (AC1)', async () => {
    const createApparatus = vi
      .fn()
      .mockImplementation((_deptId, input) =>
        Promise.resolve({ apparatusId: 'APP-ENGINE-2', ...input }),
      );
    vi.doMock('./apparatusRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./apparatusRepository.js')>();
      return { ...actual, getApparatusRepository: () => ({ createApparatus }) };
    });
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 201 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ status: 'IN_SERVICE' });
    expect(createApparatus).toHaveBeenCalledWith('NICHOLS', {
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });
  });

  it('never derives deptId from the request body, even when one is supplied (core-harm)', async () => {
    const createApparatus = vi
      .fn()
      .mockImplementation((_deptId, input) =>
        Promise.resolve({ apparatusId: 'APP-ENGINE-2', ...input }),
      );
    vi.doMock('./apparatusRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./apparatusRepository.js')>();
      return { ...actual, getApparatusRepository: () => ({ createApparatus }) };
    });
    const { handler } = await import('./createApparatus.js');

    await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE', deptId: 'FORGED-DEPT' }),
      {} as never,
      () => undefined,
    );

    expect(createApparatus).toHaveBeenCalledWith('NICHOLS', {
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });
  });

  it('returns 403 for a non-admin caller (AC3)', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(undefined, { unitId: 'ENGINE-2', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 400 when the body is absent', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, undefined),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when unitId is missing', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when type is missing', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when status is wrong-typed (a number)', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE', status: 1 }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when status is an unknown enum value', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE', status: 'RETIRED' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 (not 503) when unitId contains the pk delimiter #', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE#2', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('trims a whitespace-padded unitId before persisting it', async () => {
    const createApparatus = vi
      .fn()
      .mockImplementation((_deptId, input) =>
        Promise.resolve({ apparatusId: 'APP-ENGINE-2', ...input }),
      );
    vi.doMock('./apparatusRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./apparatusRepository.js')>();
      return { ...actual, getApparatusRepository: () => ({ createApparatus }) };
    });
    const { handler } = await import('./createApparatus.js');

    await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: '  ENGINE-2  ', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(createApparatus).toHaveBeenCalledWith('NICHOLS', {
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });
  });

  it('returns 400 when the body is a JSON array, not an object', async () => {
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, ['ENGINE-2']),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 409 problem+json on a duplicate unitId', async () => {
    vi.doMock('./apparatusRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./apparatusRepository.js')>();
      return {
        ...actual,
        getApparatusRepository: () => ({
          createApparatus: vi
            .fn()
            .mockRejectedValue(new actual.DuplicateApparatusError('ENGINE-2')),
        }),
      };
    });
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 503 problem+json (fail-closed) when DynamoDB is unavailable', async () => {
    vi.doMock('./apparatusRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./apparatusRepository.js')>();
      return {
        ...actual,
        getApparatusRepository: () => ({
          createApparatus: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
        }),
      };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./createApparatus.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH_CONTEXT, { unitId: 'ENGINE-2', type: 'ENGINE' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
  });
});
