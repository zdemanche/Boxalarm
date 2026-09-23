import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const MEMBER = { sub: 'member-1', deptId: 'dept-001', 'cognito:groups': 'member' };
const OFFICER = { sub: 'officer-1', deptId: 'dept-001', 'cognito:groups': 'training' };
const EVENT_ITEM = { eventId: 'e1', title: 'Drill', category: 'ems', startAt: 0, endAt: 0 };

function buildEvent(options: {
  principal: Record<string, string> | undefined;
  omitEventId?: boolean;
  body: string | undefined;
}): GuardEvent {
  const eventId = 'e1';
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/training/events/{eventId}/signup',
    rawPath: `/api/v1/training/events/${eventId}/signup`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: options.omitEventId ? undefined : { eventId },
    body: options.body,
    requestContext: { authorizer: { lambda: options.principal } },
  } as unknown as GuardEvent;
}

function fakeDocumentClient(sendImpl: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send: vi.fn(sendImpl) } as unknown as DynamoDBDocumentClient;
}

function seedGetEventClient(
  event: typeof EVENT_ITEM | undefined,
  extra?: (command: unknown) => unknown,
) {
  return fakeDocumentClient((command) => {
    const c = command as { constructor: { name: string } };
    if (c.constructor.name === 'GetCommand') {
      return { Item: event };
    }
    return extra ? extra(command) : {};
  });
}

async function seedClients(
  env: NodeJS.ProcessEnv,
  documentClient: DynamoDBDocumentClient,
  vpClient?: VerifiedPermissionsClient,
) {
  const { createDocumentClient } = await import('./client.js');
  createDocumentClient(env, documentClient);
  if (vpClient) {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(env, vpClient);
  }
}

function allowVp(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

function denyVp(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
  } as unknown as VerifiedPermissionsClient;
}

describe('signupHandler (POST /training/events/{eventId}/signup)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.TRAINING_TABLE_NAME = 'platform-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
  });

  it('creates a TRAINING_ATTENDANCE record for a member self-signup before the event starts (AC2, entrypoint-test)', async () => {
    vi.useFakeTimers().setSystemTime(0);
    const event = { ...EVENT_ITEM, startAt: 1_000 };
    let putCaptured: { input: Record<string, unknown> } | undefined;
    await seedClients(
      process.env,
      seedGetEventClient(event, (command) => {
        putCaptured = command as { input: Record<string, unknown> };
        return {};
      }),
    );
    const { handler } = await import('./signupHandler.js');

    const result = await handler(buildEvent({ principal: MEMBER, body: undefined }));

    expect(result).toMatchObject({ statusCode: 201 });
    const item = putCaptured!.input.Item as Record<string, unknown>;
    expect(item.sk).toBe('ATTENDEE#member-1');
    expect(item.category).toBe('ems');
  });

  it('rejects self-signup at/after the event start time with 422 — fail closed (AC2 core-harm)', async () => {
    vi.useFakeTimers().setSystemTime(5_000);
    const event = { ...EVENT_ITEM, startAt: 1_000 };
    const putSpy = vi.fn(() => ({}));
    await seedClients(process.env, seedGetEventClient(event, putSpy));
    const { handler } = await import('./signupHandler.js');

    const result = await handler(buildEvent({ principal: MEMBER, body: undefined }));

    expect(result).toMatchObject({ statusCode: 422 });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 409 on a duplicate self-signup instead of a second attendance record', async () => {
    vi.useFakeTimers().setSystemTime(0);
    const event = { ...EVENT_ITEM, startAt: 1_000 };
    await seedClients(
      process.env,
      seedGetEventClient(event, () => {
        throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      }),
    );
    const { handler } = await import('./signupHandler.js');

    const result = await handler(buildEvent({ principal: MEMBER, body: undefined }));

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('records hours for an authorized officer, including a walk-in attendee who never signed up (AC3, walk-in upsert)', async () => {
    let transactCaptured: { input: Record<string, unknown> } | undefined;
    await seedClients(
      process.env,
      seedGetEventClient(EVENT_ITEM, (command) => {
        const c = command as { constructor: { name: string } };
        if (c.constructor.name === 'TransactWriteCommand') {
          transactCaptured = command as { input: Record<string, unknown> };
        }
        return {};
      }),
      allowVp(),
    );
    const { handler } = await import('./signupHandler.js');

    const result = await handler(
      buildEvent({
        principal: OFFICER,
        body: JSON.stringify({
          attendees: [
            { memberId: 'member-1', hours: 2 },
            { memberId: 'never-signed-up', hours: 1 },
          ],
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const items = transactCaptured!.input.TransactItems as Array<{
      Update: Record<string, unknown>;
    }>;
    expect(items[0]!.Update.ExpressionAttributeValues).toMatchObject({ ':hours': 2 });
    expect(
      (items[1]!.Update.ExpressionAttributeValues as Record<string, unknown>)[':memberId'],
    ).toBe('never-signed-up');
  });

  it('denies attendees recording from a non-training-officer principal (403 row)', async () => {
    const putSpy = vi.fn(() => ({}));
    await seedClients(process.env, seedGetEventClient(EVENT_ITEM, putSpy), denyVp());
    const { handler } = await import('./signupHandler.js');

    const result = await handler(
      buildEvent({
        principal: MEMBER,
        body: JSON.stringify({ attendees: [{ memberId: 'member-1', hours: 2 }] }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 404 when the eventId does not resolve to a training event, or its path parameter is absent (malformed-path row)', async () => {
    await seedClients(process.env, seedGetEventClient(undefined));
    const { handler } = await import('./signupHandler.js');

    const missing = await handler(buildEvent({ principal: MEMBER, body: undefined }));
    expect(missing).toMatchObject({ statusCode: 404 });

    const omitted = await handler(
      buildEvent({ principal: MEMBER, omitEventId: true, body: undefined }),
    );
    expect(omitted).toMatchObject({ statusCode: 404 });
  });

  it('returns 403 when the authorizer principal is missing or invalid', async () => {
    const { handler } = await import('./signupHandler.js');

    const result = await handler(buildEvent({ principal: undefined, body: undefined }));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 400 for an invalid body — bare null, wrong-typed hours, or an empty attendees array (input-domain rows)', async () => {
    await seedClients(process.env, seedGetEventClient(EVENT_ITEM), allowVp());
    const { handler } = await import('./signupHandler.js');

    const nullBody = await handler(buildEvent({ principal: MEMBER, body: 'null' }));
    expect(nullBody).toMatchObject({ statusCode: 400 });

    const wrongTyped = await handler(
      buildEvent({
        principal: OFFICER,
        body: JSON.stringify({ attendees: [{ memberId: 'member-1', hours: 'two' }] }),
      }),
    );
    expect(wrongTyped).toMatchObject({ statusCode: 400 });

    const emptyAttendees = await handler(
      buildEvent({ principal: OFFICER, body: JSON.stringify({ attendees: [] }) }),
    );
    expect(emptyAttendees).toMatchObject({ statusCode: 400 });
  });
});
