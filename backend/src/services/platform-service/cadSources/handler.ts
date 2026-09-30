import {
  DeleteSecretCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  conflictProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { parseCadTextBounded } from '@boxalarm/cad-parser';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { getDynamoDocClient } from '../export/awsClients.js';
import { ConflictError, putDepartmentConfig } from '../config/repository.js';
import { CAD_INGRESS, loadCadIngress, readTableName } from './repository.js';
import { deleteSourceApiKey } from './rotateKey.js';
import {
  mergeSources,
  readStoredSources,
  sourceWarnings,
  toSourceView,
  validateParserFields,
  validateSourcesInput,
  type FieldError,
} from './model.js';

/**
 * The CAD sources settings (CHIEF/ADMIN):
 *   GET  /api/v1/platform/cad-sources             - Cedar ViewCadIngress
 *   PUT  /api/v1/platform/cad-sources             - Cedar ManageCadIngress
 *   POST /api/v1/platform/cad-sources/test-parse  - Cedar ManageCadIngress
 * Saved as DEPARTMENT_CONFIG configType CAD_INGRESS with its platform.config.updated outbox
 * row in the same transaction; the alerting plane projects it into CAD_INGRESS_COPY. The
 * webhook key is rotated by its own Lambda (rotateKey.ts), the only one holding the secret
 * write grant.
 */

const logger = createLogger({ service: 'platform-service' });
const MAX_SAMPLE_CHARS = 16_384;

let secretsClient: SecretsManagerClient | undefined;

/** Test seam. */
export function setSettingsSecretsClient(override: SecretsManagerClient | undefined): void {
  secretsClient = override;
}

/**
 * Deletes removed sources' webhook secrets - only names under this stack's CAD webhook prefix
 * (IAM allows nothing else). Never throws: the config is already saved and ingress already
 * refuses the removed source; a failure is logged, returned, and alarmed by the log metric.
 */
async function deleteWebhookSecrets(
  names: readonly string[],
  correlationId: string,
): Promise<number> {
  const prefix = process.env.CAD_WEBHOOK_SECRET_PREFIX;
  let failed = 0;
  for (const name of names) {
    if (!prefix || !name.startsWith(prefix)) {
      failed++;
      continue;
    }
    try {
      secretsClient ??= new SecretsManagerClient({});
      await secretsClient.send(
        new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) continue;
      failed++;
      logger.error({
        event: 'platform.cadSources.secretDeleteFailed',
        correlationId,
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
  return failed;
}

function toProblemErrors(errors: readonly FieldError[]) {
  return errors.map((error) => ({ field: error.field, detail: error.message }));
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(event: GuardEvent): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return JSON.parse(raw) as unknown;
}

function view(deptId: string, item: Awaited<ReturnType<typeof loadCadIngress>>) {
  const emailDomain = process.env.CAD_INGRESS_EMAIL_DOMAIN || undefined;
  return {
    version: item?.version ?? null,
    emailDomain: emailDomain ?? null,
    webhookUrl: process.env.CAD_WEBHOOK_URL || null,
    sources: readStoredSources(item?.value).map((source) =>
      toSourceView(source, deptId, emailDomain),
    ),
    warnings: readStoredSources(item?.value).flatMap(sourceWarnings),
  };
}

async function getSources(
  _event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const deptId = toVerifiedDeptId(principal);
  return json(200, view(deptId, await loadCadIngress(deptId)));
}

async function putSources(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  let body: unknown;
  try {
    body = parseBody(event);
  } catch {
    return badRequestProblem(traceId, 'request body must be JSON');
  }
  const input = validateSourcesInput(body);
  if (!input.ok) return badRequestProblem(traceId, toProblemErrors(input.errors));
  const expectedVersion = (body as { expectedVersion?: unknown }).expectedVersion;
  if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
    return badRequestProblem(traceId, 'expectedVersion must be an integer when provided');
  }

  const current = await loadCadIngress(deptId);
  // Optimistic lock on what the chief last loaded; a first save needs no version.
  if ((current?.version ?? undefined) !== expectedVersion) {
    return conflictProblem(traceId, 'CAD sources were changed by someone else; reload and retry');
  }
  const value = mergeSources(input.sources, readStoredSources(current?.value));
  try {
    const saved = await putDepartmentConfig(getDynamoDocClient(), {
      tableName: readTableName(),
      deptId,
      configType: CAD_INGRESS,
      value: value as unknown as Record<string, unknown>,
      actorId: principal.sub,
      correlationId: traceId,
      ...(current ? { expectedVersion: current.version } : {}),
    });
    // A removed source's webhook secret is deleted at once (security review M5): a source
    // re-created with the same id must not inherit - as its "previous" - a key that was live
    // before, and a removed source's keys should not outlive it.
    const kept = new Set(value.sources.map((source) => source.sourceId));
    const removed = readStoredSources(current?.value).filter(
      (source) => source.webhookKey && !kept.has(source.sourceId),
    );
    const secretErrors = await deleteWebhookSecrets(
      removed.map((s) => s.webhookKey!.secretName),
      traceId,
    );
    for (const source of removed) {
      await deleteSourceApiKey(source.webhookKey?.apiKeyId, traceId);
      await deleteSourceApiKey(source.webhookKey?.previousApiKeyId, traceId);
    }
    logger.info({
      event: 'platform.cadSources.updated',
      correlationId: traceId,
      actorId: principal.sub,
      version: saved.version,
      sources: value.sources.length,
    });
    return json(200, {
      ...view(deptId, saved),
      ...(secretErrors > 0
        ? {
            secretCleanupFailed: secretErrors,
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      return conflictProblem(traceId, 'CAD sources were changed by someone else; reload and retry');
    }
    throw error;
  }
}

/** Runs a draft template over a pasted sample: the same parser the ingress Lambdas run. */
async function testParse(event: GuardEvent): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  let body: unknown;
  try {
    body = parseBody(event);
  } catch {
    return badRequestProblem(traceId, 'request body must be JSON');
  }
  const { fields, sample } = (body ?? {}) as { fields?: unknown; sample?: unknown };
  if (typeof sample !== 'string' || sample.length === 0 || sample.length > MAX_SAMPLE_CHARS) {
    return badRequestProblem(traceId, [
      { field: 'sample', detail: `must be 1-${MAX_SAMPLE_CHARS} characters of dispatch text` },
    ]);
  }
  const template = validateParserFields(fields, 'fields');
  if (!template.ok) return badRequestProblem(traceId, toProblemErrors(template.errors));
  // Same deadline as ingress: a pathological pattern answers RAW (TIMEOUT), never hangs.
  const result = await parseCadTextBounded({ version: 1, fields: template.fields }, sample);
  return json(200, {
    status: result.status,
    fields: result.fields,
    ...(result.status === 'RAW' ? { reason: result.reason } : {}),
  });
}

const DEPARTMENT = (event: GuardEvent) => event.requestContext.authorizer?.lambda?.deptId ?? '';

const getHandler = withAuthorization(getSources, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewCadIngress',
  resourceType: 'Boxalarm::Department',
  resourceId: DEPARTMENT,
});

const putHandler = withAuthorization(putSources, {
  actionType: 'Boxalarm::Action',
  actionId: 'ManageCadIngress',
  resourceType: 'Boxalarm::Department',
  resourceId: DEPARTMENT,
});

const testParseHandler = withAuthorization((event) => testParse(event), {
  actionType: 'Boxalarm::Action',
  actionId: 'ManageCadIngress',
  resourceType: 'Boxalarm::Department',
  resourceId: DEPARTMENT,
});

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  switch (event.routeKey) {
    case 'GET /api/v1/platform/cad-sources':
      return getHandler(event);
    case 'PUT /api/v1/platform/cad-sources':
      return putHandler(event);
    case 'POST /api/v1/platform/cad-sources/test-parse':
      return testParseHandler(event);
    default:
      return json(404, { title: 'Not Found', status: 404 });
  }
};
