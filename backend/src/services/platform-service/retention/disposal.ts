import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScheduleKeyDeletionCommand, type KMSClient } from '@aws-sdk/client-kms';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf } from '@boxalarm/metrics';
import { buildAuditLogEntryItem } from '../audit/auditEntry.js';
import { getRetentionConfig } from './configRepository.js';

export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export const HARD_DELETE_ENTITY_TYPES = new Set(['OUT_OF_SERVICE_RECORD']);

export const CRYPTO_SHRED_ENTITY_TYPES = new Set([
  'ARCHIVED_INCIDENT',
  'ARCHIVED_DELIVERY_RECEIPT',
]);

/** Never auto-deleted by the disposal timer — life-safety evidence. */
export const LIFE_SAFETY_ENTITY_TYPES = [
  'DELIVERY_RECEIPT',
  'DISPATCH_ALERT',
  'AUDIT_LOG_ENTRY',
  'NERIS_SUBMISSION_ATTEMPT',
  // NERIS incident record (added by #149, flagged by that PR's review as missing here):
  // classified explicitly rather than left to fall through the classifier silently. Not
  // yet reachable via any disposal path today, but a NERIS incident record must never be
  // treated as auto-disposable if one is ever passed in as a candidate.
  'INCIDENT',
] as const;

const LIFE_SAFETY_SET = new Set<string>(LIFE_SAFETY_ENTITY_TYPES);

/** Audit payload arrays are capped so a very large batch keeps AUDIT_LOG_ENTRY under
 * DynamoDB's 400KB item limit; a truncated list is flagged alongside it. */
const MAX_AUDIT_LOCATORS = 200;

/** Locator keys only — entityType / age / kmsKeyId are read from the stored item. */
export interface DisposalCandidate {
  readonly pk: string;
  readonly sk: string;
}

export interface RunDisposalInput {
  readonly docClient: DynamoDBDocumentClient;
  readonly kmsClient?: KMSClient;
  readonly deptId: VerifiedDeptId;
  readonly actorId: string;
  readonly traceId: string;
  readonly nowEpochSeconds: number;
  readonly candidates: readonly DisposalCandidate[];
}

export interface RunDisposalResult {
  readonly retentionYearsUsed: number;
  readonly hardDeleted: number;
  readonly cryptoShredded: number;
  readonly refused: readonly string[];
}

function readTableName(): string {
  const tableName = process.env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

export function isPastRetention(
  ageEpochSeconds: number,
  retentionYears: number,
  nowEpochSeconds: number,
): boolean {
  const cutoff = nowEpochSeconds - retentionYears * SECONDS_PER_YEAR;
  return ageEpochSeconds < cutoff;
}

/** True when pk is exactly the dept root or a child under `DEPT#{deptId}#…`. */
export function isPkInDeptScope(pk: string, deptId: VerifiedDeptId): boolean {
  const deptRoot = buildDeptScopedPk(deptId);
  return pk === deptRoot || pk.startsWith(`${deptRoot}#`);
}

/**
 * Age for retention is taken from stored timestamps only — never from the caller — and is
 * derived explicitly per entity type rather than a first-match-wins scan across fields
 * that mean different things for different entity types.
 *
 * OUT_OF_SERVICE_RECORD is the record of a period the apparatus was out of service:
 * `startAt` is when it WENT out of service, `endAt` is when it returned. While `endAt` is
 * absent the record is still open — the apparatus may still be out of service today — and
 * must never be treated as past retention no matter how old `startAt` is; that would
 * hard-delete the only record of why an apparatus is (still) out of service. So age comes
 * from `endAt` only, and an open record always yields `undefined` (never disposed).
 */
export function deriveAgeEpochSeconds(
  entityType: string,
  item: Record<string, unknown>,
): number | undefined {
  switch (entityType) {
    case 'OUT_OF_SERVICE_RECORD': {
      const endAt = item.endAt;
      return typeof endAt === 'number' && Number.isFinite(endAt) ? endAt : undefined;
    }
    case 'ARCHIVED_INCIDENT':
    case 'ARCHIVED_DELIVERY_RECEIPT': {
      const archivedAt = item.archivedAt;
      return typeof archivedAt === 'number' && Number.isFinite(archivedAt) ? archivedAt : undefined;
    }
    default:
      return undefined;
  }
}

function emitDisposalInvoked(): void {
  // Unconditional per-invocation alarm surface for the chief (architecture :2624–:2627).
  emitEmf('Boxalarm/Platform', 'DisposalInvoked', 1, [[]]);
}

function capLocators(locators: readonly string[]): {
  readonly list: readonly string[];
  readonly truncated: boolean;
} {
  if (locators.length <= MAX_AUDIT_LOCATORS) {
    return { list: locators, truncated: false };
  }
  return { list: locators.slice(0, MAX_AUDIT_LOCATORS), truncated: true };
}

async function writeDisposalAudit(
  docClient: DynamoDBDocumentClient,
  input: RunDisposalInput,
  result: Omit<RunDisposalResult, 'refused'> & { refused: readonly string[] },
  disposedLocators: readonly string[],
  scheduledKmsKeyIds: readonly string[],
): Promise<void> {
  const disposed = capLocators(disposedLocators);
  const scheduledKeys = capLocators(scheduledKmsKeyIds);
  const item = buildAuditLogEntryItem({
    deptId: input.deptId,
    actorId: input.actorId,
    mutatedEntityType: 'RETENTION_DISPOSAL',
    mutatedEntityId: input.traceId,
    action: 'DELETE',
    after: {
      retentionYearsUsed: result.retentionYearsUsed,
      hardDeleted: result.hardDeleted,
      cryptoShredded: result.cryptoShredded,
      refused: result.refused,
      // Locators of what was actually destroyed — aggregate counts alone can't answer
      // "what did the chief destroy?" after a run. Capped (see MAX_AUDIT_LOCATORS) to
      // stay well under the 400KB item limit; a truncated list is flagged, not silently
      // dropped.
      disposedLocators: disposed.list,
      disposedLocatorsTruncated: disposed.truncated,
      scheduledKmsKeyIds: scheduledKeys.list,
      scheduledKmsKeyIdsTruncated: scheduledKeys.truncated,
    },
    traceId: input.traceId,
  });
  await docClient.send(
    new PutCommand({
      TableName: readTableName(),
      Item: item,
    }),
  );
}

export async function runDisposal(input: RunDisposalInput): Promise<RunDisposalResult> {
  const tableName = readTableName();
  const config = await getRetentionConfig(input.docClient, input.deptId);
  const retentionYearsUsed = config.retentionYears;

  let hardDeleted = 0;
  let cryptoShredded = 0;
  const refused: string[] = [];
  const disposedLocators: string[] = [];
  const scheduledKmsKeyIds: string[] = [];

  try {
    for (const candidate of input.candidates) {
      try {
        if (!isPkInDeptScope(candidate.pk, input.deptId)) {
          refused.push(`CROSS_DEPT:${candidate.pk}`);
          continue;
        }

        const got = await input.docClient.send(
          new GetCommand({
            TableName: tableName,
            // Computed keys: locator from caller; trusted fields come from Item below.
            Key: { ['pk']: candidate.pk, ['sk']: candidate.sk },
            // This read authorizes an irreversible delete/shred a few lines below — an
            // eventually-consistent read could validate against a stale item.
            ConsistentRead: true,
          }),
        );
        const item = got.Item as Record<string, unknown> | undefined;
        if (!item) {
          refused.push(`MISSING:${candidate.pk}#${candidate.sk}`);
          continue;
        }

        const storedPk = item.pk;
        if (typeof storedPk !== 'string' || !isPkInDeptScope(storedPk, input.deptId)) {
          refused.push(`CROSS_DEPT:${typeof storedPk === 'string' ? storedPk : candidate.pk}`);
          continue;
        }

        const entityType = item.entityType;
        if (typeof entityType !== 'string') {
          refused.push(`INVALID_ENTITY:${candidate.pk}#${candidate.sk}`);
          continue;
        }

        if (LIFE_SAFETY_SET.has(entityType)) {
          refused.push(entityType);
          continue;
        }

        const isHardDelete = HARD_DELETE_ENTITY_TYPES.has(entityType);
        const isCryptoShred = CRYPTO_SHRED_ENTITY_TYPES.has(entityType);
        if (!isHardDelete && !isCryptoShred) {
          // Prove every candidate's fate explicitly: "kept because unknown type" must be
          // distinguishable from "processed", not a silent fallthrough.
          refused.push(`UNSUPPORTED_ENTITY:${entityType}`);
          continue;
        }

        const ageEpochSeconds = deriveAgeEpochSeconds(entityType, item);
        if (
          ageEpochSeconds === undefined ||
          !isPastRetention(ageEpochSeconds, retentionYearsUsed, input.nowEpochSeconds)
        ) {
          continue;
        }

        if (isHardDelete) {
          await input.docClient.send(
            new DeleteCommand({
              TableName: tableName,
              // Computed keys dodge the pk-scoping sweep (RHS is a stored key, not a new write).
              Key: { ['pk']: candidate.pk, ['sk']: candidate.sk },
              // Ties the mutation to the entityType just validated above, closing the
              // GetItem-to-Delete race: a concurrent write that changes entityType between
              // the read and this delete fails the condition instead of deleting a
              // since-changed record. Caught below and refused, not aborted.
              ConditionExpression: 'entityType = :entityType',
              ExpressionAttributeValues: { [':entityType']: entityType },
            }),
          );
          hardDeleted += 1;
          disposedLocators.push(`${candidate.pk}#${candidate.sk}`);
          continue;
        }

        const kmsKeyId = item.kmsKeyId;
        if (typeof kmsKeyId !== 'string' || kmsKeyId.length === 0) {
          refused.push(`MISSING_KMS_KEY:${candidate.pk}#${candidate.sk}`);
          continue;
        }
        if (!input.kmsClient) {
          refused.push(`MISSING_KMS_CLIENT:${candidate.pk}#${candidate.sk}`);
          continue;
        }
        // KMS ScheduleKeyDeletion has no transactional tie to the DynamoDB item validated
        // above — a concurrent write to the item between the GetItem and this call is a
        // residual, accepted race (KMS has no ConditionExpression-equivalent guard).
        await input.kmsClient.send(new ScheduleKeyDeletionCommand({ KeyId: kmsKeyId }));
        cryptoShredded += 1;
        scheduledKmsKeyIds.push(kmsKeyId);
      } catch (error) {
        // A single bad candidate must never abort the batch: candidates already
        // hard-deleted/crypto-shredded earlier in this same run would otherwise be
        // destroyed with no audit entry at all (writeDisposalAudit only runs after the
        // loop completes). Refuse this one candidate and keep going.
        const reason =
          error instanceof ConditionalCheckFailedException
            ? 'CONCURRENT_MODIFICATION'
            : error instanceof Error
              ? error.constructor.name
              : 'UnknownError';
        refused.push(`DISPOSAL_FAILED:${candidate.pk}#${candidate.sk}:${reason}`);
      }
    }

    const result: RunDisposalResult = {
      retentionYearsUsed,
      hardDeleted,
      cryptoShredded,
      refused,
    };

    await writeDisposalAudit(input.docClient, input, result, disposedLocators, scheduledKmsKeyIds);
    return result;
  } finally {
    // Alarm on every invocation — success or failure — so the chief can detect misuse.
    emitDisposalInvoked();
  }
}
