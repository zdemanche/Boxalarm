import { timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { SESEvent, SESEventRecord, SESReceipt } from 'aws-lambda';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { ALERTING_SDK_CLIENT_CONFIG } from '../awsClientConfig.js';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  checkEmailSender,
  checkSesVerdicts,
  emailReplayToken,
  type EmailAuthFailure,
} from './emailAuth.js';
import { ingestCadDispatch } from './ingest.js';
import { emitCadMetric } from './metrics.js';
import { parseEmail, type ParsedEmail } from './mime.js';
import { replayMarkerOrigin } from './replayGuard.js';
import { loadCadSource, parseRecipientLocalPart, type CadSourceCopy } from './sourceCopy.js';

/**
 * SES inbound CAD email. The receipt rule stores the raw message in the encrypted mail bucket
 * (S3 action), then invokes this Lambda asynchronously with the SES verdicts.
 *
 * FAIL CLOSED on any authentication failure: the message never pages, not even as raw text.
 * It is counted (CadIngressAuthFailed{Reason}, CadIngressQuarantined - both alarmed to the
 * ops page topic) and kept: the raw message stays in the mail bucket under its SES message id
 * for review until the bucket's lifecycle expires it. Nothing from an unauthenticated
 * message's body is read or logged.
 *
 * Order: recipient -> source (the department comes from here) -> SES verdicts -> raw message
 * -> From + DKIM d= allowlist -> freshness -> replay check -> parse and write (the replay
 * marker commits in the same transaction as the dispatch).
 * A dependency failure throws, so Lambda's async retries (then the alarmed on-failure queue)
 * take over; an authentication failure returns normally - retrying it cannot succeed.
 */

const CHANNEL = 'cad-email';
export const MAX_EMAIL_BYTES = 10 * 1024 * 1024;

let s3: S3Client | undefined;
function getS3(): S3Client {
  s3 ??= captureAWSv3Client(new S3Client(ALERTING_SDK_CLIENT_CONFIG));
  return s3;
}

/** Test seam. */
export function setS3Client(client: S3Client | undefined): void {
  s3 = client;
}

interface MailConfig {
  readonly bucket: string;
  readonly prefix: string;
  readonly domain: string;
}

function readMailConfig(env: NodeJS.ProcessEnv): MailConfig {
  const bucket = env.CAD_MAIL_BUCKET;
  const domain = env.CAD_INGRESS_EMAIL_DOMAIN?.toLowerCase();
  if (!bucket || !domain) {
    throw new Error('CAD_MAIL_BUCKET and CAD_INGRESS_EMAIL_DOMAIN are required and were not set');
  }
  return { bucket, prefix: env.CAD_MAIL_PREFIX ?? 'inbound/', domain };
}

function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRawMessage(
  config: MailConfig,
  key: string,
): Promise<{ readonly raw: string } | { readonly tooLarge: true }> {
  const output = await getS3().send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  if ((output.ContentLength ?? 0) > MAX_EMAIL_BYTES) return { tooLarge: true };
  // latin1 keeps every byte; MIME decoding (mime.ts) applies each part's own charset.
  const bytes = await output.Body?.transformToByteArray();
  return { raw: bytes ? Buffer.from(bytes).toString('latin1') : '' };
}

interface IngestTarget {
  readonly deptId: VerifiedDeptId;
  readonly source: CadSourceCopy;
  readonly recipient: string;
}

interface SourceScope {
  readonly deptId: string;
  readonly sourceId: string;
}

interface IngestContext {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly sesMessageId: string;
  readonly nowSeconds: number;
}

type TargetOutcome = 'handled' | { readonly rejected: EmailAuthFailure };

async function ingestForTarget(
  context: IngestContext,
  email: ParsedEmail,
  receipt: SESReceipt,
  { deptId, source, recipient }: IngestTarget,
): Promise<TargetOutcome> {
  const { client, tableName, sesMessageId, nowSeconds } = context;
  // 4-5. From and every DKIM d= on the allowlist; Date / t= fresh.
  const senderFailure = checkEmailSender(
    email,
    source.email?.allowedSenders ?? [],
    nowSeconds,
    receipt.dmarcVerdict?.status,
    recipient,
  );
  if (senderFailure) return { rejected: senderFailure };
  logInfo('cadIngress.email.authenticated', {
    deptId,
    sourceId: source.sourceId,
    sesMessageId,
    // Recorded, as the decision record asks; GRAY (no published policy) is accepted.
    dmarc: receipt.dmarcVerdict?.status ?? 'NONE',
  });

  // 6. Replay: early read-only answer; the marker is written inside the dispatch transaction
  // (step 7), so a failed write can never leave it behind to swallow the retry (chain M3).
  const replayKey = emailReplayToken(email, nowSeconds);
  const replayRef = { deptId, sourceId: source.sourceId, token: replayKey.token };
  let marker: Awaited<ReturnType<typeof replayMarkerOrigin>> = { marked: false };
  for (const { token } of [replayKey, ...replayKey.also]) {
    marker = await replayMarkerOrigin(client, tableName, { ...replayRef, token }, nowSeconds);
    if (marker.marked) break;
  }
  if (marker.marked) {
    const ownRetry = marker.origin === sesMessageId;
    if (!ownRetry) emitCadMetric('CadIngressReplayRejected', { Channel: CHANNEL });
    logInfo(ownRetry ? 'cadIngress.email.retrySkipped' : 'cadIngress.email.replay', {
      sesMessageId,
      deptId,
      sourceId: source.sourceId,
    });
    return 'handled';
  }

  // 7. Authenticated: parse (fail open) and write the dispatch with its replay marker. A write
  // failure throws for Lambda's async retry; nothing was committed, so the retry is processed.
  const result = await ingestCadDispatch(client, tableName, {
    deptId,
    source,
    channel: CHANNEL,
    // The Subject leads: many CADs carry the call type and address there, and an empty body
    // must not make every such email the same "text" (chain review C1).
    text: email.subject ? `${email.subject}\n${email.text}` : email.text,
    receivedAt: nowSeconds,
    replay: {
      token: replayRef.token,
      ttlSeconds: replayKey.ttlSeconds,
      origin: sesMessageId,
      also: replayKey.also,
    },
  });
  logInfo('cadIngress.email.processed', {
    deptId,
    sourceId: source.sourceId,
    sesMessageId,
    outcome: result.outcome,
  });
  return 'handled';
}

async function processRecord(record: SESEventRecord, config: MailConfig): Promise<void> {
  const { mail, receipt } = record.ses;
  const sesMessageId = mail.messageId;
  const objectKey = `${config.prefix}${sesMessageId}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const quarantine = (
    reason: EmailAuthFailure | 'UnknownRecipient' | 'TooLarge',
    scope?: SourceScope,
  ) => {
    if (reason === 'UnknownRecipient') {
      // Mail to an address no source owns is internet spam to the domain, not a CAD problem:
      // counted on its own and never on the chief-facing auth/quarantine alarms, which it would
      // otherwise hold permanently in ALARM (security review minor m5). Still kept in the bucket.
      emitCadMetric('CadIngressUnknownRecipient', { Channel: CHANNEL });
      logInfo('cadIngress.email.unknownRecipient', { sesMessageId });
      return;
    }
    // A stale genuine message (a slow relay) is not an authentication failure: counted apart
    // so on-call can tell a delayed relay from a forgery (chain review m3).
    emitCadMetric(reason === 'Stale' ? 'CadIngressStale' : 'CadIngressAuthFailed', {
      Channel: CHANNEL,
      Reason: reason,
    });
    emitCadMetric('CadIngressQuarantined', { Channel: CHANNEL });
    logInfo('cadIngress.email.quarantined', {
      reason,
      sesMessageId,
      ...scope,
      quarantine: `s3://${config.bucket}/${objectKey}`,
    });
  };

  // 1-2. Recipients -> sources. The department is the source's, never the message's. One email
  // can be addressed to several departments (mutual aid): each is processed once, through its
  // first source that passes the sender check, so two addresses of one department never page it
  // twice; an unknown or stale address among them never hides a valid one, and one department's
  // failed lookup never holds up the others.
  const { tableName } = readAlertingConfig(process.env);
  const client = createDynamoClient(process.env);
  const targets = new Map<string, IngestTarget[]>();
  const failures: unknown[] = [];
  let skippedRecipients = 0;
  const skipRecipient = () => {
    skippedRecipients += 1;
    quarantine('UnknownRecipient');
  };
  for (const recipient of receipt.recipients) {
    const at = recipient.lastIndexOf('@');
    if (at <= 0 || recipient.slice(at + 1).toLowerCase() !== config.domain) {
      skipRecipient();
      continue;
    }
    const parsed = parseRecipientLocalPart(recipient.slice(0, at));
    if (!parsed) {
      skipRecipient();
      continue;
    }
    const siblings = targets.get(parsed.deptId) ?? [];
    if (siblings.some((target) => target.source.sourceId === parsed.sourceId)) continue;
    try {
      const source = await loadCadSource(client, tableName, parsed.deptId, parsed.sourceId);
      if (source?.email && tokensMatch(source.email.recipientToken, parsed.token)) {
        targets.set(parsed.deptId, [...siblings, { deptId: parsed.deptId, source, recipient }]);
      } else {
        skipRecipient();
      }
    } catch (error) {
      logError('cadIngress.email.sourceLookupFailed', error, {
        sesMessageId,
        deptId: parsed.deptId,
        sourceId: parsed.sourceId,
      });
      failures.push(error);
    }
  }
  if (targets.size === 0) {
    if (failures.length > 0) throw failures[0];
    if (skippedRecipients === 0) quarantine('UnknownRecipient');
    return;
  }

  // 3. SES verdicts.
  const verdictFailure = checkSesVerdicts(receipt);
  if (verdictFailure) return quarantine(verdictFailure);

  const message = await readRawMessage(config, objectKey);
  if ('tooLarge' in message) return quarantine('TooLarge');
  const email = parseEmail(message.raw);

  for (const candidates of targets.values()) {
    const rejections: { reason: EmailAuthFailure; scope: SourceScope }[] = [];
    let settled = false;
    for (const target of candidates) {
      try {
        const outcome = await ingestForTarget(
          { client, tableName, sesMessageId, nowSeconds },
          email,
          receipt,
          target,
        );
        if (outcome === 'handled') {
          settled = true;
          break;
        }
        rejections.push({
          reason: outcome.rejected,
          scope: { deptId: target.deptId, sourceId: target.source.sourceId },
        });
      } catch (error) {
        logError('cadIngress.email.sourceFailed', error, {
          sesMessageId,
          deptId: target.deptId,
          sourceId: target.source.sourceId,
        });
        failures.push(error);
        settled = true;
        break;
      }
    }
    if (!settled) for (const { reason, scope } of rejections) quarantine(reason, scope);
  }
  // Async invoke: Lambda retries; replay markers are per source, so targets already written skip.
  if (failures.length > 0) throw failures[0];
}

export const handler = async (event: SESEvent): Promise<void> => {
  const config = readMailConfig(process.env);
  for (const record of event.Records) {
    try {
      await processRecord(record, config);
    } catch (error) {
      logError('cadIngress.email.unavailable', error, { sesMessageId: record.ses.mail.messageId });
      emitCadMetric('CadIngressRejected', { Channel: CHANNEL, Reason: 'DependencyUnavailable' });
      // Async invoke: Lambda retries, then the alarmed on-failure queue. Nothing was paged.
      throw error;
    }
  }
};
