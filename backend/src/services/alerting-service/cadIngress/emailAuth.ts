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
  if (email.date === undefined) return 'Stale';
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

/**
 * Replay key: RFC 5322 Message-ID + the DKIM b= signatures. SES's own messageId is not used -
 * a re-sent copy of the same message gets a new one.
 */
export function emailReplayToken(email: ParsedEmail): string {
  const signatures = email.dkimSignatures.map((signature) => signature.signature).sort();
  return createHash('sha256')
    .update(`${email.messageId ?? ''}|${signatures.join('|')}`, 'utf8')
    .digest('hex');
}
