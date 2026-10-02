import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Handler, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  createRevocationClient,
  disableMemberLogin,
  enableMemberLogin,
  readRevocationConfig,
  resolveMemberDeptId,
  revokeMemberSession,
} from './cognitoRevocationClient.js';
import { writeRevocationMarker } from '../authorizer/revocationStore.js';
import type { RevocationConfig } from './cognitoRevocationClient.js';
import {
  getAccessStoreClient,
  readMemberStatus,
  readPlatformTableName,
} from './memberAccessStore.js';

const REVOKING_STATUSES = new Set(['LOA', 'RETIRED']);
// Statuses that may use the app. PROBATIONARY is where every new member starts.
const RESTORING_STATUSES = new Set(['ACTIVE', 'PROBATIONARY']);

let cachedClient: CognitoIdentityProviderClient | undefined;

function getClient(): CognitoIdentityProviderClient {
  cachedClient ??= createRevocationClient();
  return cachedClient;
}

interface MemberStatusChangedPayload {
  readonly memberId: string;
  readonly status: string;
  readonly deptId?: string | undefined;
  readonly correlationId?: string | undefined;
}

interface MemberStatusEnvelope {
  readonly eventType?: unknown;
  readonly correlationId?: unknown;
  readonly payload?: {
    memberId?: unknown;
    status?: unknown;
    newStatus?: unknown;
    deptId?: unknown;
  };
}

// EventBridge -> SQS delivers its own envelope with the producer payload nested under
// `detail` unless the rule carries an input transformer; accept both shapes so a plain
// domain-envelope body (e.g. from a direct SQS test fixture) and a real EventBridge-wrapped
// body both parse.
function unwrapEnvelope(rawBody: string): MemberStatusEnvelope {
  const parsed: unknown = JSON.parse(rawBody);
  if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
    return parsed.detail ?? parsed;
  }
  return parsed as MemberStatusEnvelope;
}

function memberKeyOf(record: SQSRecord): string | undefined {
  try {
    const memberId = unwrapEnvelope(record.body).payload?.memberId;
    return typeof memberId === 'string' ? memberId : undefined;
  } catch {
    return undefined;
  }
}

function safeExtractCorrelationId(record: SQSRecord): string | undefined {
  try {
    const envelope = unwrapEnvelope(record.body);
    return typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns undefined for a member.updated that is not a status change: profile, push-token
 * and role changes share the event type but carry no status, and must not be retried into
 * the DLQ. The status is `status`, or `newStatus` for events emitted before updateMemberStatus
 * also wrote `status` - a redriven LOA/RETIRED event must still revoke. A missing memberId,
 * or a status that is present but unusable, is still malformed.
 */
function parseMemberStatusEvent(record: SQSRecord): MemberStatusChangedPayload | undefined {
  const envelope = unwrapEnvelope(record.body);
  if (envelope.eventType !== 'personnel.member.updated') {
    throw new Error(`unexpected eventType: ${JSON.stringify(envelope.eventType)}`);
  }
  const memberId = envelope.payload?.memberId;
  if (typeof memberId !== 'string' || memberId.trim().length === 0) {
    throw new Error('payload.memberId is required and was not a non-empty string');
  }
  const status = envelope.payload?.status ?? envelope.payload?.newStatus;
  if (status === undefined) {
    return undefined;
  }
  if (typeof status !== 'string' || status.trim().length === 0) {
    throw new Error('payload.status is required and was not a non-empty string');
  }
  const correlationId =
    typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined;
  const deptId = envelope.payload?.deptId;
  return {
    memberId,
    status,
    deptId: typeof deptId === 'string' && deptId.trim().length > 0 ? deptId : undefined,
    correlationId,
  };
}

/**
 * The status to act on: the member row's current status when the event names a department
 * (see readMemberStatus for why), else the event's own status. A read failure throws so SQS
 * retries - guessing would either lock out a returned member or leave a retired one in.
 */
async function resolveEffectiveStatus(
  payload: MemberStatusChangedPayload,
  tableName: string,
  fallback: string,
): Promise<string> {
  if (!payload.deptId) {
    return fallback;
  }
  const current = await readMemberStatus(
    getAccessStoreClient(),
    tableName,
    payload.deptId,
    payload.memberId,
  );
  return current ?? fallback;
}

/**
 * Security-web MINOR 9: an event emitted before updateMemberStatus carried `deptId` (only a DLQ
 * redrive can deliver one now) used to skip the row re-read and act on its own status - so a
 * redriven LOA or RETIRED event disabled a member who is ACTIVE today. Its department is
 * resolved from the login's custom:deptId (as applyStatus already did for the marker), so it
 * converges on the row like every other event. A login with no department keeps the event's
 * status: there is no row to read.
 */
async function withResolvedDept(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  payload: MemberStatusChangedPayload,
): Promise<MemberStatusChangedPayload> {
  if (payload.deptId) {
    return payload;
  }
  const deptId = await resolveMemberDeptId(client, { userPoolId, username: payload.memberId });
  console.log(
    JSON.stringify({
      event: 'memberStatusRevocation.legacyEventDeptResolved',
      memberId: payload.memberId,
      resolved: deptId !== undefined,
      correlationId: payload.correlationId,
      service: 'platform-service',
    }),
  );
  return deptId ? { ...payload, deptId } : payload;
}

type LoginState = 'disabled' | 'enabled' | 'untouched';

function loginStateFor(status: string): LoginState {
  if (REVOKING_STATUSES.has(status)) {
    return 'disabled';
  }
  return RESTORING_STATUSES.has(status) ? 'enabled' : 'untouched';
}

const MAX_RECONCILE_ROUNDS = 3;

/**
 * Review of fix/access-control, MAJOR 2: reading the row and then acting is a race. An
 * officer sets LOA by mistake and corrects it to ACTIVE a moment later: the LOA record reads
 * LOA, the ACTIVE record reads ACTIVE and enables, then the LOA record disables - leaving an
 * ACTIVE member locked out of Cognito with nothing to repair it.
 *
 * So after acting, re-read the row (consistent read) and, if the login state it calls for
 * differs from what was just applied, apply that instead. Whichever handler makes the LAST
 * Cognito call re-reads after it, so the final Cognito state always matches the row as of a
 * moment after every call; a row write later than that re-read raises its own event. The
 * alternative - a FIFO queue grouped by member - was rejected: EventBridge's SQS target takes
 * only a static MessageGroupId, so it would serialise every member behind one group, and the
 * queue replacement is a riskier change than this bounded loop. Records for one member within
 * a batch are also processed in order (see the handler).
 */
async function convergeLoginState(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  tableName: string,
  event: MemberStatusChangedPayload,
): Promise<void> {
  const payload = await withResolvedDept(client, userPoolId, event);
  let status = await resolveEffectiveStatus(payload, tableName, payload.status);
  for (let round = 1; round <= MAX_RECONCILE_ROUNDS; round += 1) {
    await applyStatus(client, userPoolId, tableName, payload, status);
    if (!payload.deptId) {
      return; // A login with no department has no member row to re-read.
    }
    const after = await resolveEffectiveStatus(payload, tableName, status);
    if (loginStateFor(after) === loginStateFor(status)) {
      return;
    }
    console.log(
      JSON.stringify({
        event: 'memberStatusRevocation.reconciled',
        memberId: payload.memberId,
        applied: status,
        current: after,
        round,
        correlationId: payload.correlationId,
        service: 'platform-service',
      }),
    );
    status = after;
  }
  // Still changing after three rounds: let SQS retry the record rather than guess.
  throw new Error(`member ${payload.memberId} status kept changing while being applied`);
}

async function applyStatus(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  tableName: string,
  payload: MemberStatusChangedPayload,
  status: string,
): Promise<void> {
  const input = { userPoolId, username: payload.memberId, correlationId: payload.correlationId };
  if (REVOKING_STATUSES.has(status)) {
    // M1: the marker makes the authorizer refuse the access tokens already issued (they are
    // verified offline and would otherwise live out their hour). A member with no department
    // attribute holds no token the authorizer accepts, so there is nothing to mark.
    const deptId =
      payload.deptId ??
      (await resolveMemberDeptId(client, { userPoolId, username: payload.memberId }));
    if (deptId) {
      await writeRevocationMarker(getAccessStoreClient(), tableName, {
        deptId,
        sub: payload.memberId,
        reason: 'MEMBER_STATUS',
      });
    }
    // Disable next: once it lands no new sign-in or refresh can succeed, so the sign-out
    // that follows cannot race a refresh that re-mints a session.
    await disableMemberLogin(client, input);
    await revokeMemberSession(client, input);
    return;
  }
  if (RESTORING_STATUSES.has(status)) {
    await enableMemberLogin(client, input);
  }
}

/**
 * Partial batch response (review minor 15): only the records that failed are retried, so a
 * good record in a batch with a bad one is not re-applied (re-writing its revocation marker
 * and repeating its Cognito calls). A config error still fails the whole batch - nothing in
 * it can succeed. Needs ReportBatchItemFailures on the event source mapping
 * (infrastructure/components/identity/session-revocation.ts).
 */
export const handler: Handler<SQSEvent, SQSBatchResponse> = async (event) => {
  let config: RevocationConfig;
  let tableName: string;
  try {
    config = readRevocationConfig(process.env);
    tableName = readPlatformTableName(process.env);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'memberStatusRevocation.configError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    throw error;
  }
  const { userPoolId } = config;
  const client = getClient();

  // Members are processed concurrently - revocations are independent, and running them all
  // serially made duration grow with batch size - but one member's records run in arrival
  // order, so a batch holding LOA then ACTIVE for the same member cannot interleave with
  // itself (MAJOR 2; convergeLoginState covers records in different batches).
  const byMember = new Map<string, SQSRecord[]>();
  for (const record of event.Records) {
    const key = memberKeyOf(record) ?? `unparsed:${record.messageId}`;
    byMember.set(key, [...(byMember.get(key) ?? []), record]);
  }
  const processRecord = async (record: SQSRecord): Promise<void> => {
    let payload: MemberStatusChangedPayload | undefined;
    try {
      payload = parseMemberStatusEvent(record);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'memberStatusRevocation.malformedPayload',
          message: error instanceof Error ? error.message : undefined,
          messageId: record.messageId,
          correlationId: safeExtractCorrelationId(record),
          service: 'platform-service',
        }),
      );
      throw error;
    }

    if (!payload) {
      return;
    }

    try {
      await convergeLoginState(client, userPoolId, tableName, payload);
    } catch (error) {
      // UserNotFoundException is not retryable -- no-op instead of DLQ-storming.
      if (error instanceof UserNotFoundException) {
        return;
      }
      throw error;
    }
  };
  const results = (
    await Promise.all(
      [...byMember.values()].map(async (records) => {
        const failed: string[] = [];
        for (const record of records) {
          // Once one of a member's records fails, retry the rest after it rather than apply
          // them out of order.
          if (failed.length > 0) {
            failed.push(record.messageId);
            continue;
          }
          try {
            await processRecord(record);
          } catch (error) {
            console.error(
              JSON.stringify({
                event: 'memberStatusRevocation.recordFailed',
                messageId: record.messageId,
                reason: error instanceof Error ? error.constructor.name : 'UnknownError',
                message: error instanceof Error ? error.message : undefined,
                service: 'platform-service',
              }),
            );
            failed.push(record.messageId);
          }
        }
        return failed;
      }),
    )
  ).flat();

  return { batchItemFailures: results.map((itemIdentifier) => ({ itemIdentifier })) };
};
