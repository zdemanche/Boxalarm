import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';

/**
 * Paging review MAJOR-A: list a member's current/upcoming mark-offs and end one early. Cedar is
 * faked to answer as the deployed policies do: ViewOwnAvailability/EndOwnMarkoff for every role,
 * ViewMemberAvailability/EndMemberMarkoff for OFFICER/CHIEF/ADMIN. The token is the caller's
 * groups so the fake can decide.
 */
const OFFICER_ACTIONS = new Set(['ViewMemberAvailability', 'EndMemberMarkoff']);
const vpSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return { ...actual, VerifiedPermissionsClient: vi.fn(() => ({ send: vpSend })) };
});

const NOW = 1_800_000_000;
const DEPT = 'NICHOLS';

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function markoff(startAt: number, endAt: number, extra: Record<string, unknown> = {}) {
  return {
    pk: `DEPT#${DEPT}#MEMBER#mbr-1`,
    sk: `MARKOFF#${startAt}`,
    entityType: 'AVAILABILITY_MARKOFF',
    memberId: 'mbr-1',
    deptId: DEPT,
    startAt,
    endAt,
    affectsAlerting: true,
    ...extra,
  };
}

function event(groups: string, sub: string, memberId: string, markoffId?: string): GuardEvent {
  return {
    headers: { authorization: `Bearer ${groups.replace(/ /g, ',')}` },
    pathParameters: { memberId, ...(markoffId !== undefined ? { markoffId } : {}) },
    requestContext: { authorizer: { lambda: { sub, deptId: DEPT, 'cognito:groups': groups } } },
  } as unknown as GuardEvent;
}

describe('availability mark-off routes', () => {
  const originalEnv = { ...process.env };
  let ddbSend: ReturnType<typeof vi.fn>;
  let schedulerSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    vpSend.mockImplementation(
      (command: { input: { accessToken: string; action: { actionId: string } } }) => {
        const groups = command.input.accessToken.split(',');
        const allowed = OFFICER_ACTIONS.has(command.input.action.actionId)
          ? groups.some((g) => ['OFFICER', 'CHIEF', 'ADMIN'].includes(g))
          : true;
        return Promise.resolve({ decision: allowed ? 'ALLOW' : 'DENY' });
      },
    );
    ddbSend = vi.fn().mockResolvedValue({});
    schedulerSend = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./dynamoClient.js')>()),
      createDdbClient: () => ({ send: ddbSend }),
    }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./dynamoClient.js');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function routes() {
    const { createListHandler, createEndHandler } = await import('./markoffs.js');
    return {
      list: createListHandler(),
      end: createEndHandler({ schedulerClient: { send: schedulerSend } as never }),
    };
  }

  const bodyOf = (result: unknown) =>
    JSON.parse((result as { body: string }).body) as Record<string, unknown>;

  describe('GET .../availability', () => {
    it('lists the member’s current and upcoming mark-offs, oldest first, never ended or past ones', async () => {
      ddbSend.mockResolvedValue({
        Items: [
          markoff(NOW + 7200, NOW + 9000, { reason: 'Vacation' }),
          markoff(NOW - 60, NOW + 3600),
          markoff(NOW - 9000, NOW - 60),
          markoff(NOW - 100, NOW + 100, { revertedAt: NOW - 10 }),
        ],
      });
      const { list } = await routes();

      const result = await list(event('MEMBER', 'mbr-1', 'mbr-1'));

      expect(result).toMatchObject({ statusCode: 200 });
      expect(bodyOf(result)).toEqual({
        markOffs: [
          { markoffId: String(NOW - 60), startAt: NOW - 60, endAt: NOW + 3600 },
          {
            markoffId: String(NOW + 7200),
            startAt: NOW + 7200,
            endAt: NOW + 9000,
            reason: 'Vacation',
          },
        ],
      });
      const query = ddbSend.mock.calls[0]![0] as Command;
      expect(query.input.ExpressionAttributeValues).toMatchObject({
        ':pk': 'DEPT#NICHOLS#MEMBER#mbr-1',
        ':prefix': 'MARKOFF#',
      });
    });

    it('an officer may list another member; a member may not', async () => {
      ddbSend.mockResolvedValue({ Items: [] });
      const { list } = await routes();

      expect(await list(event('MEMBER OFFICER', 'off-1', 'mbr-1'))).toMatchObject({
        statusCode: 200,
      });
      expect(await list(event('MEMBER', 'mbr-2', 'mbr-1'))).toMatchObject({ statusCode: 403 });
    });
  });

  describe('POST .../availability/{markoffId}/end', () => {
    function table(item: Record<string, unknown> | undefined) {
      ddbSend.mockImplementation((command: Command) =>
        Promise.resolve(command.constructor.name === 'GetCommand' ? { Item: item } : {}),
      );
    }

    it('ends a current mark-off now: keeps the row, sets endAt, emits AVAILABLE, audits, deletes its schedules', async () => {
      table(markoff(NOW - 60, NOW + 3600, { activatedAt: NOW - 60 }));
      schedulerSend.mockRejectedValueOnce(
        Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }),
      );
      const { end } = await routes();

      const result = await end(event('MEMBER', 'mbr-1', 'mbr-1', String(NOW - 60)));

      expect(result).toMatchObject({ statusCode: 200 });
      expect(bodyOf(result)).toMatchObject({ endedAt: NOW, cancelled: false });
      const transact = ddbSend.mock.calls
        .map(([c]) => c as Command)
        .find((c) => c.constructor.name === 'TransactWriteCommand')!;
      const items = transact.input.TransactItems as Array<
        Record<
          string,
          { Item?: Record<string, unknown>; ExpressionAttributeValues?: Record<string, unknown> }
        >
      >;
      expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({
        ':endAt': NOW,
        ':now': NOW,
        ':actor': 'mbr-1',
        ':cancelled': false,
      });
      expect(items.some((i) => i.Delete)).toBe(false);
      expect(items[1]!.Put!.Item).toMatchObject({
        entityType: 'OUTBOX_ENTRY',
        eventType: 'personnel.availability.changed',
        source: 'personnel-service',
        schemaVersion: '1.0',
        payload: { memberId: 'mbr-1', availabilityState: 'AVAILABLE', startAt: NOW - 60 },
      });
      expect(typeof items[1]!.Put!.Item!.eventTime).toBe('string');
      expect(items[2]!.Put!.Item).toMatchObject({
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: 'AVAILABILITY_MARKOFF',
        actorId: 'mbr-1',
      });
      expect(schedulerSend).toHaveBeenCalledTimes(2);
    });

    it('cancels an upcoming mark-off: endAt = startAt, still AVAILABLE on the bus', async () => {
      table(markoff(NOW + 7200, NOW + 9000));
      const { end } = await routes();

      const result = await end(event('MEMBER OFFICER', 'off-1', 'mbr-1', String(NOW + 7200)));

      expect(bodyOf(result)).toMatchObject({ cancelled: true });
      const transact = ddbSend.mock.calls
        .map(([c]) => c as Command)
        .find((c) => c.constructor.name === 'TransactWriteCommand')!;
      const update = (
        transact.input.TransactItems as Array<{
          Update?: { ExpressionAttributeValues: Record<string, unknown> };
        }>
      )[0]!.Update!;
      expect(update.ExpressionAttributeValues).toMatchObject({
        ':endAt': NOW + 7200,
        ':cancelled': true,
        ':actor': 'off-1',
      });
    });

    it('an already-ended mark-off answers 200 alreadyEnded and writes nothing', async () => {
      table(markoff(NOW - 600, NOW - 60, { revertedAt: NOW - 60 }));
      const { end } = await routes();

      const result = await end(event('MEMBER', 'mbr-1', 'mbr-1', String(NOW - 600)));

      expect(bodyOf(result)).toMatchObject({ alreadyEnded: true });
      expect(
        ddbSend.mock.calls.some(
          ([c]) => (c as Command).constructor.name === 'TransactWriteCommand',
        ),
      ).toBe(false);
    });

    it('404s an unknown mark-off, 400s a malformed id, and refuses a member ending someone else’s', async () => {
      table(undefined);
      const { end } = await routes();

      expect(await end(event('MEMBER', 'mbr-1', 'mbr-1', '123'))).toMatchObject({
        statusCode: 404,
      });
      expect(await end(event('MEMBER', 'mbr-1', 'mbr-1', 'abc'))).toMatchObject({
        statusCode: 400,
      });
      expect(await end(event('MEMBER', 'mbr-2', 'mbr-1', '123'))).toMatchObject({
        statusCode: 403,
      });
    });
  });
});
