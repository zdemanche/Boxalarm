import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * One-shot backfill for the alerting plane's ALERT_RULES_COPY (review MINOR-7).
 *
 * The alerting plane learns a department's ALERT_RULES only from `platform.config.updated`
 * (alerting's alertRulesCopyHandler) and never reads this table, so a department whose rules were
 * saved before that consumer was deployed runs its tone ladder on the defaults until someone saves
 * again. This re-emits each department's CURRENT rules through the platform outbox, exactly as
 * PUT /platform/config does; the consumer then writes the copy (guarded on the config version,
 * so running it twice is harmless).
 *
 * Self-contained (AWS SDK only) so it runs directly under Node's type stripping:
 *   node src/services/platform-service/config/reemitAlertRules.ts \
 *     --table boxalarm-<env>-platform --dept <deptId> [--dept <deptId> ...]
 */

interface AlertRulesRow {
  readonly version?: unknown;
  readonly value?: unknown;
  readonly updatedBy?: unknown;
}

/** The outbox row PUT /platform/config writes for a config change (@boxalarm/outbox). */
export function buildReemitRecord(
  deptId: string,
  row: AlertRulesRow,
  now: Date = new Date(),
): Record<string, unknown> {
  const eventId = randomUUID();
  const eventTime = now.toISOString();
  return {
    pk: `DEPT#${deptId}#OUTBOX`,
    sk: `EVENT#${eventTime}#${eventId}`,
    entityType: 'OUTBOX_ENTRY',
    eventId,
    eventTime,
    eventType: 'platform.config.updated',
    source: 'platform-service',
    correlationId: `alert-rules-backfill-${deptId}`,
    schemaVersion: '1.0',
    payload: {
      configType: 'ALERT_RULES',
      version: row.version,
      value: row.value,
      updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : 'alert-rules-backfill',
      deptId,
    },
    sentAt: null,
  };
}

export type ReemitOutcome = 'reemitted' | 'no-rules';

export async function reemitAlertRules(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
): Promise<ReemitOutcome> {
  const { Item } = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `DEPT#${deptId}`, sk: 'CONFIG#ALERT_RULES' },
    }),
  );
  if (!Item) {
    return 'no-rules';
  }
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: buildReemitRecord(deptId, Item as AlertRulesRow),
    }),
  );
  return 'reemitted';
}

function parseArgs(argv: readonly string[]): { table: string; depts: string[] } {
  let table: string | undefined;
  const depts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--table') table = argv[++i];
    else if (argv[i] === '--dept' && argv[i + 1]) depts.push(argv[++i]!);
  }
  if (!table || depts.length === 0) {
    throw new Error('usage: reemitAlertRules.ts --table <platform table> --dept <deptId> [...]');
  }
  return { table, depts };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  const { table, depts } = parseArgs(process.argv.slice(2));
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  for (const deptId of depts) {
    const outcome = await reemitAlertRules(client, table, deptId);
    console.log(
      `${deptId}: ${outcome === 'reemitted' ? 're-emitted ALERT_RULES' : 'no ALERT_RULES saved; defaults apply'}`,
    );
  }
}
