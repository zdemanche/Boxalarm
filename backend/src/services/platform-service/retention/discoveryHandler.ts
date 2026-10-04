import type { Handler, ScheduledEvent } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { emitEmf } from '@boxalarm/metrics';
import { getDynamoDocClient } from './awsClients.js';
import { discoverDisposalCandidates } from './discovery.js';

interface Deps {
  readonly docClient?: DynamoDBDocumentClient;
}

function readTableName(): string {
  const tableName = process.env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

/** Capped so a very large sweep keeps the CloudWatch Logs event small — the
 * DisposalCandidatesFound alarm (retention.ts), not this log line, is what pages the
 * chief; the log is only for the follow-up admin to see what to review. */
const MAX_LOGGED_LOCATORS = 50;

function log(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      service: 'platform-service',
      event: 'retention.discovery.scan',
      ...fields,
    }),
  );
}

/**
 * Scheduled, read-only candidate-discovery sweep for records disposal (E8-S9-INFRA
 * #260). Emits DisposalCandidatesFound (Boxalarm/platform) so retention.ts's alarm can
 * notify the chief — it never calls runDisposal itself. An admin reviews the logged
 * locators and, if they agree, POSTs them to /platform/retention/disposal (the
 * existing Cedar-gated, admin-only, unconditionally-alarmed destructive action).
 */
export function createHandler(deps: Deps = {}): Handler<ScheduledEvent, void> {
  return async () => {
    const tableName = readTableName();
    const docClient = getDynamoDocClient(deps.docClient);
    const candidates = await discoverDisposalCandidates({
      docClient,
      tableName,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    });

    emitEmf('Boxalarm/platform', 'DisposalCandidatesFound', candidates.length, [[]]);

    if (candidates.length > 0) {
      log({
        candidateCount: candidates.length,
        truncated: candidates.length > MAX_LOGGED_LOCATORS,
        sample: candidates
          .slice(0, MAX_LOGGED_LOCATORS)
          .map((c) => `${c.deptId}:${c.entityType}:${c.pk}#${c.sk}`),
      });
    }
  };
}

export const handler = createHandler();
