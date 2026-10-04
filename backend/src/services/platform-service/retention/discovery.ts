import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  CRYPTO_SHRED_ENTITY_TYPES,
  HARD_DELETE_ENTITY_TYPES,
  deriveAgeEpochSeconds,
  isPastRetention,
} from './disposal.js';
import { getRetentionConfig } from './configRepository.js';

/** Every entityType runDisposal (disposal.ts) is able to act on — anything else is
 * never a candidate no matter how old, including every LIFE_SAFETY_ENTITY_TYPES row. */
const DISPOSABLE_ENTITY_TYPES: readonly string[] = [
  ...HARD_DELETE_ENTITY_TYPES,
  ...CRYPTO_SHRED_ENTITY_TYPES,
];

export interface DisposalCandidateLocator {
  readonly deptId: string;
  readonly pk: string;
  readonly sk: string;
  readonly entityType: string;
}

export interface DiscoverDisposalCandidatesInput {
  readonly docClient: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly nowEpochSeconds: number;
}

/** pk is always `DEPT#{deptId}` or `DEPT#{deptId}#...` (the dept-scoping invariant
 * every writer on this table is held to — see findPkScopingViolations). */
function deptIdFromPk(pk: string): string | undefined {
  return /^DEPT#([^#]+)/.exec(pk)?.[1];
}

/**
 * Non-destructive: scans for rows whose entityType is one runDisposal can act on
 * (HARD_DELETE_ENTITY_TYPES / CRYPTO_SHRED_ENTITY_TYPES) and whose derived age has
 * crossed the owning department's configured retention window. It never deletes or
 * crypto-shreds anything, and never touches a LIFE_SAFETY_ENTITY_TYPES row (those
 * entity types are excluded by construction — they are not in DISPOSABLE_ENTITY_TYPES
 * regardless of age).
 *
 * This is the "detection" half of the architecture's stated posture on destructive
 * admin actions (Security & Auth: "detection and reversal, not prevention" for N6.3
 * disposal) — runDisposal (disposal.ts) remains the sole, Cedar-gated, admin-posted
 * action that actually destroys anything.
 */
export async function discoverDisposalCandidates(
  input: DiscoverDisposalCandidatesInput,
): Promise<readonly DisposalCandidateLocator[]> {
  const candidates: DisposalCandidateLocator[] = [];
  const retentionYearsByDept = new Map<string, number>();

  const valueNames = DISPOSABLE_ENTITY_TYPES.map((_, i) => `:t${i}`);
  const expressionAttributeValues: Record<string, string> = {};
  DISPOSABLE_ENTITY_TYPES.forEach((entityType, i) => {
    expressionAttributeValues[valueNames[i] as string] = entityType;
  });

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await input.docClient.send(
      new ScanCommand({
        TableName: input.tableName,
        FilterExpression: `entityType IN (${valueNames.join(', ')})`,
        ExpressionAttributeValues: expressionAttributeValues,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const items = (page.Items ?? []) as Record<string, unknown>[];
    for (const item of items) {
      const pk = item.pk;
      const sk = item.sk;
      const entityType = item.entityType;
      if (typeof pk !== 'string' || typeof sk !== 'string' || typeof entityType !== 'string') {
        continue;
      }
      const deptId = deptIdFromPk(pk);
      if (!deptId) {
        continue;
      }

      let retentionYears = retentionYearsByDept.get(deptId);
      if (retentionYears === undefined) {
        const verifiedDeptId = toVerifiedDeptId({ deptId });
        const config = await getRetentionConfig(input.docClient, verifiedDeptId);
        retentionYears = config.retentionYears;
        retentionYearsByDept.set(deptId, retentionYears);
      }

      const ageEpochSeconds = deriveAgeEpochSeconds(entityType, item);
      if (
        ageEpochSeconds === undefined ||
        !isPastRetention(ageEpochSeconds, retentionYears, input.nowEpochSeconds)
      ) {
        continue;
      }

      candidates.push({ deptId, pk, sk, entityType });
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return candidates;
}
