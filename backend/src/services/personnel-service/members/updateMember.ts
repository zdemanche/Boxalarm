import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  forbiddenProblem,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { readMemberServiceConfig } from '../config.js';
import { INVALID_PHONE_MESSAGE, normalizePhoneE164 } from '../lib/phone.js';
import {
  getCognitoClient,
  readMemberLoginConfig,
  syncMemberLoginEmail,
} from '../lib/memberLogin.js';

const UPDATABLE_FIELDS = ['phone', 'email', 'firstName', 'lastName'] as const;
type UpdatableField = (typeof UPDATABLE_FIELDS)[number];
/** `phone: null` clears the member's phone (and so their SMS and voice targets). */
type UpdateMemberBody = Partial<Record<Exclude<UpdatableField, 'phone'>, string>> & {
  phone?: string | null;
};

function parseBody(raw: string | undefined | null): UpdateMemberBody | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const updates: Record<string, string | null> = {};
  for (const field of UPDATABLE_FIELDS) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    if (field === 'phone' && value === null) {
      updates.phone = null;
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    updates[field] = value;
  }
  return Object.keys(updates).length === 0 ? undefined : updates;
}

function isMemberConditionFailure(error: TransactionCanceledException): boolean {
  return error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

function emitPersonnelMetric(
  outcome:
    | 'MemberProfileUpdated'
    | 'MemberProfileUpdateFailed'
    | 'MemberEmailChanged'
    | 'MemberEmailSyncFailed'
    | 'MemberEmailCompensationFailed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

let cachedClient: DynamoDBDocumentClient | undefined;

function getDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

function problem(status: number, title: string, detail: string, traceId: string) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title, status, detail, traceId }),
  };
}

function logEvent(event: string, fields: Record<string, unknown>, error?: unknown): void {
  const log = error === undefined ? console.log : console.error;
  log(
    JSON.stringify({
      event,
      service: 'personnel-service',
      ...fields,
      ...(error !== undefined
        ? {
            reason: error instanceof Error ? error.constructor.name : 'UnknownError',
            message: error instanceof Error ? error.message : undefined,
          }
        : {}),
    }),
  );
}

type EditMode = 'self' | 'admin';

interface ProfileDeps {
  readonly client?: DynamoDBDocumentClient;
  readonly cognito?: CognitoIdentityProviderClient;
}

/**
 * Security-web MAJOR 2: the member's email is also their login's recovery address - where
 * "Reset password" sends its code. An edit that reached only this row left Cognito on the old
 * address, so recovery diverged. A changed email is therefore written to Cognito first and the
 * row second, with the Cognito change undone if the row write fails.
 *
 * Only a chief or admin (UpdateMember) may change it. A member's own edit (SelfUpdateMember)
 * that changes it is refused: a stolen session could otherwise move the recovery address and
 * defeat "Reset password and sign out", the one control that ends that session. An own edit
 * that re-sends the unchanged address (the app's profile form always does) is a no-op.
 */
async function updateMemberProfile(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  mode: EditMode,
  deps: ProfileDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required.');
  }

  const parsed = parseBody(event.body);
  if (!parsed) {
    return badRequestProblem(
      traceId,
      'Request body must be JSON with at least one of phone, email, firstName, lastName as a non-empty string (phone may be null to clear it).',
    );
  }
  // Stored in E.164: the alerting plane texts and dials exactly this string (lib/phone.ts).
  let updates: UpdateMemberBody = parsed;
  if (parsed.phone !== undefined && parsed.phone !== null) {
    const phone = normalizePhoneE164(parsed.phone);
    if (!phone) {
      return badRequestProblem(traceId, INVALID_PHONE_MESSAGE);
    }
    updates = { ...parsed, phone };
  }

  const deptId = toVerifiedDeptId(principal);
  const now = Date.now();
  const eventId = randomUUID();
  const config = readMemberServiceConfig(process.env);
  const docClient = getDocClient(deps.client);
  const rowKey = { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' };

  // The previous address, when this edit really changes it (read in the caller's own
  // department: a member of another department is a 404 before Cognito is touched).
  let previousEmail: string | undefined;
  if (updates.email !== undefined) {
    const current = await docClient.send(
      new GetCommand({ TableName: config.tableName, Key: rowKey, ConsistentRead: true }),
    );
    if (!current.Item) {
      emitPersonnelMetric('MemberProfileUpdateFailed', 'NotFound');
      return notFoundProblem(traceId, `Member ${memberId} was not found.`);
    }
    const stored = typeof current.Item.email === 'string' ? current.Item.email : undefined;
    if (stored === updates.email) {
      updates = Object.fromEntries(Object.entries(updates).filter(([field]) => field !== 'email'));
    } else if (mode === 'self') {
      logEvent('personnel.member.update.selfEmailRefused', { correlationId: traceId, memberId });
      return problem(
        403,
        'Forbidden',
        'Your email is also where password-reset codes go, so only a chief or admin can change it. Ask them to update it.',
        traceId,
      );
    } else {
      previousEmail = stored;
    }
  }

  const cognito =
    previousEmail !== undefined || updates.email !== undefined ? deps.cognito : undefined;
  const loginConfig = updates.email !== undefined ? readMemberLoginConfig(process.env) : undefined;
  if (updates.email !== undefined && loginConfig) {
    try {
      await syncMemberLoginEmail(
        cognito ?? getCognitoClient(),
        loginConfig,
        memberId,
        updates.email,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      logEvent('personnel.member.email.syncFailed', { correlationId: traceId, memberId }, error);
      emitPersonnelMetric('MemberEmailSyncFailed', reason);
      if (reason === 'InvalidParameterException') {
        return badRequestProblem(traceId, 'email is not a valid email address.');
      }
      if (reason === 'UserNotFoundException') {
        return problem(
          409,
          'Conflict',
          'This member has no sign-in account to update, so the email was not changed.',
          traceId,
        );
      }
      return problem(
        503,
        'Service Unavailable',
        'The sign-in service could not be updated, so the email was not changed. Try again.',
        traceId,
      );
    }
  }

  // A cleared phone is REMOVEd from the row; the event still carries `phone: null`, which the
  // alerting plane reads as "remove this member's SMS and voice targets".
  const setFields = Object.entries(updates).filter(([, value]) => value !== null);
  const clearsPhone = updates.phone === null;
  const nameExpressions = Object.fromEntries(
    Object.keys(updates).map((field) => [`#${field}`, field]),
  );
  const valueExpressions: Record<string, unknown> = Object.fromEntries(
    setFields.map(([field, value]) => [`:${field}`, value]),
  );
  const setClauses = setFields
    .map(([field]) => `#${field} = :${field}`)
    .concat('#updatedAt = :updatedAt');

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.tableName,
              Key: rowKey,
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: `SET ${setClauses.join(', ')}${clearsPhone ? ' REMOVE #phone' : ''}`,
              ExpressionAttributeNames: { ...nameExpressions, '#updatedAt': 'updatedAt' },
              ExpressionAttributeValues: { ...valueExpressions, ':updatedAt': now },
            },
          },
          {
            Put: {
              TableName: config.tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'OUTBOX', memberId),
                sk: `EVT#${eventId}`,
                entityType: 'OUTBOX_ENTRY',
                eventId,
                eventTime: new Date(now).toISOString(),
                eventType: 'personnel.member.updated',
                source: 'personnel-service',
                correlationId: memberId,
                schemaVersion: '1.0',
                deptId,
                memberId,
                payload: { deptId, memberId, ...updates },
                createdAt: now,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (updates.email !== undefined && loginConfig && previousEmail !== undefined) {
      await restoreLoginEmail(
        cognito ?? getCognitoClient(),
        loginConfig,
        memberId,
        previousEmail,
        traceId,
      );
    }
    if (error instanceof TransactionCanceledException && isMemberConditionFailure(error)) {
      console.error(
        JSON.stringify({
          event: 'personnel.member.update.notFound',
          service: 'personnel-service',
          correlationId: traceId,
          memberId,
        }),
      );
      emitPersonnelMetric('MemberProfileUpdateFailed', 'NotFound');
      return notFoundProblem(traceId, `Member ${memberId} was not found.`);
    }
    console.error(
      JSON.stringify({
        event: 'personnel.member.update.failed',
        service: 'personnel-service',
        correlationId: traceId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitPersonnelMetric(
      'MemberProfileUpdateFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }

  emitPersonnelMetric('MemberProfileUpdated');
  if (updates.email !== undefined) {
    // Alarmed to the chief (infra personnel/members.ts): the recovery address moved.
    emitPersonnelMetric('MemberEmailChanged');
    logEvent('personnel.member.email.changed', {
      correlationId: traceId,
      memberId,
      actorId: principal.sub,
    });
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, updatedAt: now, ...updates }),
  };
}

/** Compensation: the row write failed after Cognito took the new address. */
async function restoreLoginEmail(
  cognito: CognitoIdentityProviderClient,
  loginConfig: ReturnType<typeof readMemberLoginConfig>,
  memberId: string,
  previousEmail: string,
  traceId: string,
): Promise<void> {
  try {
    await syncMemberLoginEmail(cognito, loginConfig, memberId, previousEmail);
  } catch (error) {
    // Cognito now holds an address the row does not: recovery goes somewhere the admin
    // console does not show. Counted (alarmed with the email change) and named in the log.
    logEvent(
      'personnel.member.email.compensationFailed',
      { correlationId: traceId, memberId },
      error,
    );
    emitPersonnelMetric('MemberEmailCompensationFailed');
  }
}

/**
 * PUT /members/{memberId} serves two Cedar actions (F2.6, AP 12):
 *  - SelfUpdateMember — a member editing their OWN profile; every role holds it.
 *  - UpdateMember — editing ANOTHER member's profile; admin-only (CHIEF/ADMIN).
 * withAuthorization binds one static action, so the request is routed to the matching
 * guard by comparing the path memberId to the authorizer's sub. The self path re-checks
 * memberId === principal.sub against the guard-verified principal before any write, so a
 * SelfUpdateMember ALLOW can never reach another member's row.
 */
export function createHandler(
  deps: {
    client?: DynamoDBDocumentClient;
    vpClient?: VerifiedPermissionsClient;
    cognito?: CognitoIdentityProviderClient;
  } = {},
) {
  const common = {
    actionType: 'Boxalarm::Action',
    resourceType: 'Boxalarm::Member',
    resourceId: (event: GuardEvent) => event.pathParameters?.memberId ?? '',
    ...(deps.vpClient ? { client: deps.vpClient } : {}),
  };

  const selfUpdate = withAuthorization(
    async (event, principal) => {
      if (event.pathParameters?.memberId !== principal.sub) {
        return forbiddenProblem(extractTraceId(event));
      }
      return updateMemberProfile(event, principal, 'self', deps);
    },
    { ...common, actionId: 'SelfUpdateMember' },
  );

  const adminUpdate = withAuthorization(
    (event, principal) => updateMemberProfile(event, principal, 'admin', deps),
    { ...common, actionId: 'UpdateMember' },
  );

  return (event: GuardEvent) => {
    const callerSub = event.requestContext.authorizer?.lambda?.sub;
    const memberId = event.pathParameters?.memberId;
    return callerSub && memberId === callerSub ? selfUpdate(event) : adminUpdate(event);
  };
}

export const handler = createHandler();
