import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { ForbiddenError, requireAdminRole } from '../lib/authz.js';
import { createMember, getMember } from '../lib/memberRepository.js';
import type { NewMemberInput } from '../lib/memberRepository.js';
import { logError, logInfo } from '../lib/logger.js';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  InvalidMemberEmailError,
  MemberLoginExistsError,
  adoptExistingLogin,
  createMemberLogin,
  deleteMemberLogin,
  getCognitoClient,
  readMemberLoginConfig,
} from '../lib/memberLogin.js';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeEmail } from '../lib/email.js';
import { INVALID_PHONE_MESSAGE, normalizePhoneE164 } from '../lib/phone.js';

const REQUIRED_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'joinDate',
  'rank',
  'agencyId',
] as const;

function parseCreateInput(body: string | undefined): NewMemberInput {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error('request body must be valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('request body must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const input: Partial<Record<(typeof REQUIRED_FIELDS)[number], string>> = {};
  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${field} is required and must be a non-empty string`);
    }
    input[field] = value;
  }
  // Stored in E.164: the alerting plane texts and dials exactly this string (lib/phone.ts).
  const phone = normalizePhoneE164(input.phone!);
  if (!phone) {
    throw new Error(INVALID_PHONE_MESSAGE);
  }
  input.phone = phone;
  input.email = normalizeEmail(input.email!);
  return input as NewMemberInput;
}

function emitMemberMetric(name: 'MemberCreated' | 'MemberLoginOrphaned'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: 1,
    }),
  );
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<VerifiedAccessToken> = async (
  event,
) => {
  const ctx = event.requestContext.authorizer.lambda;
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  try {
    requireAdminRole(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      logError('member.create.forbidden', traceId, error, {
        actorId: ctx.sub,
        route: 'POST /members',
      });
      return problemResponse(403, 'Forbidden', error.message, traceId);
    }
    throw error;
  }

  let input: NewMemberInput;
  try {
    input = parseCreateInput(event.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid request body';
    return problemResponse(400, 'Bad Request', detail, traceId);
  }

  let config;
  let loginConfig;
  try {
    config = readPersonnelConfig(process.env);
    loginConfig = readMemberLoginConfig(process.env);
  } catch (error) {
    logError('member.create.misconfigured', traceId, error);
    return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
  }

  // The login comes first: its sub is the memberId (lib/memberLogin.ts).
  const cognito = getCognitoClient();
  const deptId = toVerifiedDeptId(ctx);
  let memberId: string;
  let adopted = false;
  try {
    memberId = await createMemberLogin(cognito, loginConfig, { email: input.email, deptId });
  } catch (error) {
    if (!(error instanceof MemberLoginExistsError)) {
      if (error instanceof InvalidMemberEmailError) {
        logError('member.create.invalid_email', traceId, error);
        return problemResponse(400, 'Bad Request', 'email is not a valid email address.', traceId);
      }
      logError('member.create.login_failed', traceId, error);
      return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
    }
    let adoptedSub: string | undefined;
    try {
      adoptedSub = await adoptExistingLogin(cognito, loginConfig, { email: input.email, deptId });
    } catch (lookupError) {
      logError('member.create.login_lookup_failed', traceId, lookupError);
      return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
    }
    if (!adoptedSub) {
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    memberId = adoptedSub;
    adopted = true;
  }

  try {
    if (adopted && (await getMember(config.tableName, ctx, memberId))) {
      return problemResponse(
        409,
        'Conflict',
        new MemberLoginExistsError(input.email).message,
        traceId,
      );
    }
    const member = await createMember(config.tableName, ctx, input, ctx.sub, memberId);
    emitMemberMetric('MemberCreated');
    logInfo('member.created', traceId, { memberId: member.memberId });
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(member),
    };
  } catch (error) {
    logError('member.create.failed', traceId, error);
    if (
      !adopted &&
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return problemResponse(
        409,
        'Conflict',
        new MemberLoginExistsError(input.email).message,
        traceId,
      );
    }
    if (!adopted) {
      try {
        await deleteMemberLogin(cognito, loginConfig, input.email);
      } catch (cleanupError) {
        logError('member.create.login_orphaned', traceId, cleanupError, { memberId });
        emitMemberMetric('MemberLoginOrphaned');
      }
    }
    return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
  }
};
