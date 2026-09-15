import { ScheduleKeyDeletionCommand, type KMSClient } from '@aws-sdk/client-kms';
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
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

export interface DisposalCandidate {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: string;
  /** Epoch seconds used to decide whether the record is past retention. */
  readonly ageEpochSeconds: number;
  readonly kmsKeyId?: string;
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
      if (LIFE_SAFETY_SET.has(candidate.entityType)) {
        refused.push(candidate.entityType);
        continue;
      }

      if (!isPastRetention(candidate.ageEpochSeconds, retentionYearsUsed, input.nowEpochSeconds)) {
        continue;
      }

      if (HARD_DELETE_ENTITY_TYPES.has(candidate.entityType)) {
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

      if (CRYPTO_SHRED_ENTITY_TYPES.has(candidate.entityType)) {
        if (!candidate.kmsKeyId) {
          throw new Error(
            `kmsKeyId is required to crypto-shred ${candidate.entityType} ${candidate.pk}`,
          );
        }
        if (!input.kmsClient) {
          throw new Error('kmsClient is required to crypto-shred archived classes');
        }
        await input.kmsClient.send(new ScheduleKeyDeletionCommand({ KeyId: candidate.kmsKeyId }));
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
