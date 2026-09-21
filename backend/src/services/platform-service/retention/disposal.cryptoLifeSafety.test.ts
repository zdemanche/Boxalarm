import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleKeyDeletionCommand, type KMSClient } from '@aws-sdk/client-kms';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { LIFE_SAFETY_ENTITY_TYPES, SECONDS_PER_YEAR, runDisposal } from './disposal.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function keyOf(pk: string, sk: string): string {
  return `${pk}\0${sk}`;
}

function createMemoryDocClient(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(
    Object.entries(seed).map(([key, value]) => [key, { ...value }]),
  );
  const puts: Record<string, unknown>[] = [];

  const send = vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      const pk = command.input.Key?.pk as string;
      const sk = command.input.Key?.sk as string;
      const item = store.get(keyOf(pk, sk));
      return item ? { Item: item } : {};
    }
    if (command instanceof DeleteCommand) {
      const pk = command.input.Key?.pk as string;
      const sk = command.input.Key?.sk as string;
      store.delete(keyOf(pk, sk));
      return {};
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item as Record<string, unknown>;
      puts.push(item);
      store.set(keyOf(item.pk as string, item.sk as string), item);
      return {};
    }
    return {};
  });

  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    store,
    puts,
    send,
  };
}

function fakeKmsClient(sendImpl?: (command: unknown) => unknown) {
  return { send: vi.fn(sendImpl ?? (() => ({}))) } as unknown as KMSClient & {
    send: ReturnType<typeof vi.fn>;
  };
}

describe('runDisposal crypto-shred and life-safety (AC3, AC4)', () => {
  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('crypto-shreds archived incident / delivery-receipt classes via ScheduleKeyDeletion', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 8 * SECONDS_PER_YEAR;
    const kms = fakeKmsClient();
    const incPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'INC-1');
    const rcptPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'RCPT-1');
    const { client } = createMemoryDocClient({
      [keyOf(incPk, 'METADATA')]: {
        pk: incPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_INCIDENT',
        archivedAt: age,
        kmsKeyId: 'arn:aws:kms:us-east-1:123:key/inc-key',
      },
      [keyOf(rcptPk, 'METADATA')]: {
        pk: rcptPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_DELIVERY_RECEIPT',
        archivedAt: age,
        kmsKeyId: 'arn:aws:kms:us-east-1:123:key/rcpt-key',
      },
    });

    const result = await runDisposal({
      docClient: client,
      kmsClient: kms,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-shred-1',
      nowEpochSeconds: nowEpoch,
      candidates: [
        { pk: incPk, sk: 'METADATA' },
        { pk: rcptPk, sk: 'METADATA' },
      ],
    });

    expect(result.cryptoShredded).toBe(2);
    expect(kms.send.mock.calls).toHaveLength(2);
    const keyIds = kms.send.mock.calls.map((call) => {
      const cmd = call[0] as ScheduleKeyDeletionCommand;
      expect(cmd).toBeInstanceOf(ScheduleKeyDeletionCommand);
      return cmd.input.KeyId;
    });
    expect(keyIds).toEqual([
      'arn:aws:kms:us-east-1:123:key/inc-key',
      'arn:aws:kms:us-east-1:123:key/rcpt-key',
    ]);
  });

  it('ignores caller-supplied kmsKeyId and uses the stored key only', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 8 * SECONDS_PER_YEAR;
    const kms = fakeKmsClient();
    const incPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'INC-2');
    const { client } = createMemoryDocClient({
      [keyOf(incPk, 'METADATA')]: {
        pk: incPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_INCIDENT',
        archivedAt: age,
        kmsKeyId: 'arn:aws:kms:us-east-1:123:key/stored-key',
      },
    });

    const result = await runDisposal({
      docClient: client,
      kmsClient: kms,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-shred-stored-key',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: incPk, sk: 'METADATA' }],
    });

    expect(result.cryptoShredded).toBe(1);
    const cmd = kms.send.mock.calls[0]?.[0] as ScheduleKeyDeletionCommand;
    expect(cmd.input.KeyId).toBe('arn:aws:kms:us-east-1:123:key/stored-key');
  });

  it('refuses life-safety evidence classes and never DeleteItem / shreds them', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const kms = fakeKmsClient();
    const lifeSafety = [...LIFE_SAFETY_ENTITY_TYPES].map((entityType, index) => ({
      pk: buildDeptScopedPk(DEPT_ID, 'EVIDENCE', entityType),
      sk: `ITEM#${index}`,
      entityType,
      startAt: age,
      kmsKeyId: `key-${entityType}`,
    }));

    const { client, store } = createMemoryDocClient(
      Object.fromEntries(
        lifeSafety.map((item) => [
          keyOf(item.pk, item.sk),
          {
            pk: item.pk,
            sk: item.sk,
            entityType: item.entityType,
            startAt: item.startAt,
            kmsKeyId: item.kmsKeyId,
          },
        ]),
      ),
    );

    const result = await runDisposal({
      docClient: client,
      kmsClient: kms,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-refuse-1',
      nowEpochSeconds: nowEpoch,
      candidates: lifeSafety.map(({ pk, sk }) => ({ pk, sk })),
    });

    expect(LIFE_SAFETY_ENTITY_TYPES).toEqual(
      expect.arrayContaining([
        'DELIVERY_RECEIPT',
        'DISPATCH_ALERT',
        'AUDIT_LOG_ENTRY',
        'NERIS_SUBMISSION_ATTEMPT',
      ]),
    );
    expect(result.hardDeleted).toBe(0);
    expect(result.cryptoShredded).toBe(0);
    expect(result.refused).toEqual([...LIFE_SAFETY_ENTITY_TYPES]);
    expect(kms.send.mock.calls).toHaveLength(0);
    for (const item of lifeSafety) {
      expect(store.has(keyOf(item.pk, item.sk))).toBe(true);
    }
  });

  it('refuses (not throws) a candidate missing kmsKeyId, and keeps processing the batch', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 8 * SECONDS_PER_YEAR;
    const kms = fakeKmsClient();
    const noKeyPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'INC-NOKEY');
    const okPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'INC-OK');
    const { client, store } = createMemoryDocClient({
      [keyOf(noKeyPk, 'METADATA')]: {
        pk: noKeyPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_INCIDENT',
        archivedAt: age,
        // No kmsKeyId.
      },
      [keyOf(okPk, 'METADATA')]: {
        pk: okPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_INCIDENT',
        archivedAt: age,
        kmsKeyId: 'arn:aws:kms:us-east-1:123:key/ok-key',
      },
    });

    const result = await runDisposal({
      docClient: client,
      kmsClient: kms,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-missing-kms-key',
      nowEpochSeconds: nowEpoch,
      // The candidate missing a kmsKeyId is deliberately first, so a naive implementation
      // that throws mid-loop would abort before reaching the second, valid candidate.
      candidates: [
        { pk: noKeyPk, sk: 'METADATA' },
        { pk: okPk, sk: 'METADATA' },
      ],
    });

    expect(result.refused).toEqual([`MISSING_KMS_KEY:${noKeyPk}#METADATA`]);
    expect(result.cryptoShredded).toBe(1);
    expect(kms.send.mock.calls).toHaveLength(1);
    expect(store.has(keyOf(noKeyPk, 'METADATA'))).toBe(true);
  });

  it('refuses (not throws) a candidate when no kmsClient was provided, and keeps processing the batch', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 8 * SECONDS_PER_YEAR;
    const shredPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'INC-NOCLIENT');
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-STILL-RUNS');
    const oosAge = nowEpoch - 8 * SECONDS_PER_YEAR;
    const { client, store } = createMemoryDocClient({
      [keyOf(shredPk, 'METADATA')]: {
        pk: shredPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_INCIDENT',
        archivedAt: age,
        kmsKeyId: 'arn:aws:kms:us-east-1:123:key/would-be-shredded',
      },
      [keyOf(oosPk, `OOS#${oosAge}`)]: {
        pk: oosPk,
        sk: `OOS#${oosAge}`,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: oosAge,
        endAt: oosAge,
      },
    });

    const result = await runDisposal({
      docClient: client,
      // No kmsClient provided at all.
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-missing-kms-client',
      nowEpochSeconds: nowEpoch,
      candidates: [
        { pk: shredPk, sk: 'METADATA' },
        { pk: oosPk, sk: `OOS#${oosAge}` },
      ],
    });

    expect(result.refused).toEqual([`MISSING_KMS_CLIENT:${shredPk}#METADATA`]);
    expect(result.cryptoShredded).toBe(0);
    // The batch kept going past the crypto-shred failure and still hard-deleted the
    // unrelated, independently-eligible OOS candidate.
    expect(result.hardDeleted).toBe(1);
    expect(store.has(keyOf(oosPk, `OOS#${oosAge}`))).toBe(false);
  });

  it('classifies INCIDENT as life-safety evidence and never disposes it (E8-S9 review, PR #149 follow-up)', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const incidentPk = buildDeptScopedPk(DEPT_ID, 'NERIS', 'INC-1');
    const incidentSk = 'METADATA';
    const { client, store } = createMemoryDocClient({
      [keyOf(incidentPk, incidentSk)]: {
        pk: incidentPk,
        sk: incidentSk,
        entityType: 'INCIDENT',
        startAt: age,
        archivedAt: age,
      },
    });

    const result = await runDisposal({
      docClient: client,
      kmsClient: fakeKmsClient(),
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-incident-life-safety',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: incidentPk, sk: incidentSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(result.cryptoShredded).toBe(0);
    expect(result.refused).toEqual(['INCIDENT']);
    expect(store.has(keyOf(incidentPk, incidentSk))).toBe(true);
  });

  it('records scheduled KMS key ids on the AUDIT_LOG_ENTRY, not just aggregate counts', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 8 * SECONDS_PER_YEAR;
    const kms = fakeKmsClient();
    const incPk = buildDeptScopedPk(DEPT_ID, 'ARCHIVE', 'INC-AUDIT');
    const { client, puts } = createMemoryDocClient({
      [keyOf(incPk, 'METADATA')]: {
        pk: incPk,
        sk: 'METADATA',
        entityType: 'ARCHIVED_INCIDENT',
        archivedAt: age,
        kmsKeyId: 'arn:aws:kms:us-east-1:123:key/audited-key',
      },
    });

    await runDisposal({
      docClient: client,
      kmsClient: kms,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-audit-kms',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: incPk, sk: 'METADATA' }],
    });

    const audit = puts.find((item) => item.entityType === 'AUDIT_LOG_ENTRY') as
      { changedFields: { scheduledKmsKeyIds: { new: readonly string[] } } } | undefined;
    expect(audit?.changedFields.scheduledKmsKeyIds.new).toEqual([
      'arn:aws:kms:us-east-1:123:key/audited-key',
    ]);
  });

  it('writes an AUDIT_LOG_ENTRY and emits DisposalInvoked EMF on every invocation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const nowEpoch = 1_800_000_000;
    const { client, puts } = createMemoryDocClient();

    await runDisposal({
      docClient: client,
      kmsClient: fakeKmsClient(),
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-audit-1',
      nowEpochSeconds: nowEpoch,
      candidates: [],
    });

    const audit = puts.find((item) => item.entityType === 'AUDIT_LOG_ENTRY');
    expect(audit).toMatchObject({
      entityType: 'AUDIT_LOG_ENTRY',
      mutatedEntityType: 'RETENTION_DISPOSAL',
      action: 'DELETE',
      actorId: 'MBR-CHIEF',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DisposalInvoked'));
  });
});
