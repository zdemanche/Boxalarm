import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Handler, SQSEvent, SQSRecord } from 'aws-lambda';
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
): Promise<string> {
  if (!payload.deptId) {
    return payload.status;
  }
  const current = await readMemberStatus(
    getAccessStoreClient(),
    tableName,
    payload.deptId,
    payload.memberId,
  );
  return current ?? payload.status;
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

export const handler: Handler<SQSEvent, void> = async (event) => {
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

  // Records are processed concurrently: revokeMemberSession calls are independent, and
  // running them serially made invocation duration grow linearly with batch size while
  // also letting one malformed record block every later record in the same batch.
  const results = await Promise.allSettled(
    event.Records.map(async (record) => {
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
        const status = await resolveEffectiveStatus(payload, tableName);
        await applyStatus(client, userPoolId, tableName, payload, status);
      } catch (error) {
        // UserNotFoundException is not retryable -- no-op instead of DLQ-storming.
        if (error instanceof UserNotFoundException) {
          return;
        }
        throw error;
      }
    }),
  );

  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }
};
