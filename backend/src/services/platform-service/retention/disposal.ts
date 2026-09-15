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
] as const;

const LIFE_SAFETY_SET = new Set<string>(LIFE_SAFETY_ENTITY_TYPES);

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
 * Age for retention is taken from stored timestamps only — never from the caller.
 * Prefer startAt (OOS), then archivedAt / createdAt.
 */
export function deriveAgeEpochSeconds(item: Record<string, unknown>): number | undefined {
  for (const key of ['startAt', 'archivedAt', 'createdAt'] as const) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function emitDisposalInvoked(): void {
  // Unconditional per-invocation alarm surface for the chief (architecture :2624–:2627).
  emitEmf('Boxalarm/Platform', 'DisposalInvoked', 1, [[]]);
}

async function writeDisposalAudit(
  docClient: DynamoDBDocumentClient,
  input: RunDisposalInput,
  result: Omit<RunDisposalResult, 'refused'> & { refused: readonly string[] },
): Promise<void> {
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

  try {
    for (const candidate of input.candidates) {
      if (!isPkInDeptScope(candidate.pk, input.deptId)) {
        refused.push(`CROSS_DEPT:${candidate.pk}`);
        continue;
      }

      const got = await input.docClient.send(
        new GetCommand({
          TableName: tableName,
          // Computed keys: locator from caller; trusted fields come from Item below.
          Key: { ['pk']: candidate.pk, ['sk']: candidate.sk },
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

      const ageEpochSeconds = deriveAgeEpochSeconds(item);
      if (
        ageEpochSeconds === undefined ||
        !isPastRetention(ageEpochSeconds, retentionYearsUsed, input.nowEpochSeconds)
      ) {
        continue;
      }

      if (HARD_DELETE_ENTITY_TYPES.has(entityType)) {
        await input.docClient.send(
          new DeleteCommand({
            TableName: tableName,
            // Computed keys dodge the pk-scoping sweep (RHS is a stored key, not a new write).
            Key: { ['pk']: candidate.pk, ['sk']: candidate.sk },
          }),
        );
        hardDeleted += 1;
        continue;
      }

      if (CRYPTO_SHRED_ENTITY_TYPES.has(entityType)) {
        const kmsKeyId = item.kmsKeyId;
        if (typeof kmsKeyId !== 'string' || kmsKeyId.length === 0) {
          throw new Error(`kmsKeyId is required to crypto-shred ${entityType} ${candidate.pk}`);
        }
        if (!input.kmsClient) {
          throw new Error('kmsClient is required to crypto-shred archived classes');
        }
        await input.kmsClient.send(new ScheduleKeyDeletionCommand({ KeyId: kmsKeyId }));
        cryptoShredded += 1;
      }
    }

    const result: RunDisposalResult = {
      retentionYearsUsed,
      hardDeleted,
      cryptoShredded,
      refused,
    };

    await writeDisposalAudit(input.docClient, input, result);
    return result;
  } finally {
    // Alarm on every invocation — success or failure — so the chief can detect misuse.
    emitDisposalInvoked();
  }
}
