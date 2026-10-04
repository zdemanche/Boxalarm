import { createHash } from 'node:crypto';
import type { SESReceipt } from 'aws-lambda';
import { isAligned } from './address.js';
import type { ParsedEmail } from './mime.js';

/**
 * Email sender authentication (docs/decisions/2026-09-29-cad-ingress-auth.md, "Email path",
 * tightened by the security review). Accept only when ALL hold:
 *  - SES verdicts: SPF PASS, DKIM PASS, spam not FAIL, virus not FAIL, DMARC not FAIL;
 *  - exactly one From header with exactly one mailbox, parsed by the RFC 5322 grammar;
 *  - that mailbox is on the source's allowlist (address entries: exact address only);
 *  - DMARC PASS, or every DKIM d= aligned with the From domain (checkEmailSender);
 *  - the ingress address it arrived on is in the DKIM-signed To or Cc;
 *  - Date and every DKIM t= fresh.
 * There is no allowlist-only mode: a From header alone is trivially forged.
 */

/** DKIM t= (the signer's own clock at signing): 10 minutes, per the decision record. */
export const EMAIL_FRESHNESS_SECONDS = 600;
/**
 * The Date header: 60 minutes (chain review m3). SMTP queueing plus Lambda's async retries can
 * delay a genuine dispatch past 10 minutes; replay is covered by the 24 h Message-ID marker and
 * a signed t= where the signer sets one.
 */
export const EMAIL_DATE_FRESHNESS_SECONDS = 60 * 60;
export const EMAIL_REPLAY_TTL_SECONDS = 24 * 60 * 60;

export type EmailAuthFailure =
  | 'SpfFailed'
  | 'DkimFailed'
  | 'DmarcFailed'
  | 'Spam'
  | 'Virus'
  | 'MalformedHeaders'
  | 'FromUnparseable'
  | 'SenderNotAllowed'
  | 'DkimNotAligned'
  | 'RecipientNotSigned'
  | 'Stale';

export function checkSesVerdicts(receipt: SESReceipt): EmailAuthFailure | undefined {
  if (receipt.spfVerdict?.status !== 'PASS') return 'SpfFailed';
  if (receipt.dkimVerdict?.status !== 'PASS') return 'DkimFailed';
  if (receipt.virusVerdict?.status === 'FAIL') return 'Virus';
  if (receipt.spamVerdict?.status === 'FAIL') return 'Spam';
  if (receipt.dmarcVerdict?.status === 'FAIL') return 'DmarcFailed';
  return undefined;
}

/**
 * The sender checks after the SES verdicts (security review C1):
 *  - exactly one From header holding exactly one mailbox (address.ts - display names and
 *    comments are never searched for addresses);
 *  - that mailbox is on the allowlist: an ADDRESS entry matches that exact address only; only a
 *    DOMAIN entry the chief typed as a domain matches every mailbox of that domain;
 *  - alignment: DMARC PASS (SES's aligned verdict), or - when the domain publishes no usable
 *    DMARC result (GRAY, PROCESSING_FAILED, absent) - EVERY DKIM signature's d= aligned with the
 *    From domain, so the signature SES verified is necessarily an aligned one. A message with no
 *    DKIM signature, or with any foreign one, fails;
 *  - Date and every DKIM t= fresh.
 */
export function checkEmailSender(
  email: ParsedEmail,
  allowedSenders: readonly string[],
  nowSeconds: number,
  dmarcStatus?: string,
  /** The ingress address this message was received on (the SES recipient that matched). */
  recipient?: string,
): EmailAuthFailure | undefined {
  // Headers we might read differently from SES, or a DKIM signature we cannot read or that
  // signs only part of the body, fail - never treated as absent (security review M6/m11).
  if (email.headerError) return 'MalformedHeaders';
  if (email.fromError || !email.fromAddress || !email.fromDomain) return 'FromUnparseable';
  const fromAllowed = allowedSenders.some((entry) =>
    entry.includes('@') ? entry === email.fromAddress : entry === email.fromDomain,
  );
  if (!fromAllowed) return 'SenderNotAllowed';
  const fromDomain = email.fromDomain;
  if (
    email.dkimSignatures.length === 0 ||
    (dmarcStatus !== 'PASS' &&
      email.dkimSignatures.some((signature) => !isAligned(signature.domain, fromDomain)))
  ) {
    return 'DkimNotAligned';
  }
  // Bound to THIS department (security review M2): the address the message arrived on must be in
  // its To or Cc, and every signature must cover that header. A genuine county email redirected
  // unchanged to another department's address keeps its original To and fails here.
  if (recipient !== undefined) {
    const wanted = recipient.toLowerCase();
    const header = email.toAddresses.includes(wanted)
      ? 'to'
      : email.ccAddresses.includes(wanted)
        ? 'cc'
        : undefined;
    if (
      !header ||
      email.dkimSignatures.some((signature) => !signature.signedHeaders.includes(header))
    ) {
      return 'RecipientNotSigned';
    }
  }
  // Date counts only when every signature covers it (mime.ts). Otherwise freshness rests on
  // the DKIM t= tags - and then EVERY signature must carry a fresh t=: taking any one would let
  // an appended, aligned bogus signature with a fresh t= make an old genuine message fresh
  // again (security review R3-M1). With a signed Date, any t= present must still be fresh.
  if (email.date === undefined) {
    const everyFresh =
      email.dkimSignatures.length > 0 &&
      email.dkimSignatures.every(
        (signature) =>
          signature.timestamp !== undefined &&
          Math.abs(nowSeconds - signature.timestamp) <= EMAIL_FRESHNESS_SECONDS,
      );
    return everyFresh ? undefined : 'Stale';
  }
  if (Math.abs(nowSeconds - email.date) > EMAIL_DATE_FRESHNESS_SECONDS) return 'Stale';
  if (
    email.dkimSignatures.some(
      (signature) =>
        signature.timestamp !== undefined &&
        Math.abs(nowSeconds - signature.timestamp) > EMAIL_FRESHNESS_SECONDS,
    )
  ) {
    return 'Stale';
  }
  return undefined;
}

/** How long a body-only replay key outlives the moment the message would go stale. */
export const EMAIL_REPLAY_MARGIN_SECONDS = 5 * 60;

/**
 * The last second at which checkEmailSender's freshness rule still accepts this message,
 * computed from the SAME constants and the same "which times count" rule, so the replay hold
 * cannot drift from the freshness window (security review R3b-M1):
 *  - Date signed by every signature: Date + 60 min, and no later than any t= + 10 min;
 *  - Date unsigned: the earliest t= + 10 min (every signature must carry a fresh t=).
 * Undefined when no time bounds the message (it fails freshness anyway).
 */
export function emailFreshUntil(email: ParsedEmail): number | undefined {
  const signatureBounds = email.dkimSignatures
    .map((signature) => signature.timestamp)
    .filter((t): t is number => t !== undefined)
    .map((t) => t + EMAIL_FRESHNESS_SECONDS);
  if (email.date !== undefined) {
    return Math.min(email.date + EMAIL_DATE_FRESHNESS_SECONDS, ...signatureBounds);
  }
  if (email.dkimSignatures.length === 0 || signatureBounds.length !== email.dkimSignatures.length) {
    return undefined;
  }
  return Math.min(...signatureBounds);
}

/**
 * How long a body-only replay key is held: until the message could no longer pass freshness,
 * plus a margin. That is about 65 minutes for a just-sent message with a signed Date, and about
 * 15 minutes when only t= bounds it (security review R3b-M1: a flat 15 minutes let an
 * unchanged genuine email with a signed Date re-page 15 to 60 minutes later). Short enough that
 * two genuine messages with identical bodies well apart are not mistaken for a replay.
 */
export function emailBodyReplayTtlSeconds(email: ParsedEmail, nowSeconds: number): number {
  const freshUntil = emailFreshUntil(email) ?? nowSeconds;
  return Math.max(0, freshUntil - nowSeconds) + EMAIL_REPLAY_MARGIN_SECONDS;
}

/**
 * Replay key. With a SIGNED Message-ID: that id + a hash of the signed Subject and the body
 * (held 24 h). Without one: a hash of the decoded body alone - the part DKIM protects that a
 * replayer cannot change. Never the b= or bh= values: a replayer can append signatures of
 * their own, and each would change the key (security review R3-M1). SES's own messageId is
 * never used either (a re-sent copy gets a new one).
 */
export function emailReplayToken(
  email: ParsedEmail,
  nowSeconds: number,
): {
  readonly token: string;
  readonly ttlSeconds: number;
} {
  if (email.messageId) {
    const content = createHash('sha256')
      .update(`${email.subject ?? ''}\n${email.text}`, 'utf8')
      .digest('hex');
    return {
      token: createHash('sha256').update(`${email.messageId}|${content}`, 'utf8').digest('hex'),
      ttlSeconds: EMAIL_REPLAY_TTL_SECONDS,
    };
  }
  const body = createHash('sha256').update(email.text, 'utf8').digest('hex');
  return {
    token: createHash('sha256').update(`NOMSGID|${body}`, 'utf8').digest('hex'),
    ttlSeconds: emailBodyReplayTtlSeconds(email, nowSeconds),
  };
}
