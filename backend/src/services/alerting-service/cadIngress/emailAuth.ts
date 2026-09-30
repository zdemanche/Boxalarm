import { createHash } from 'node:crypto';
import type { SESReceipt } from 'aws-lambda';
import type { ParsedEmail } from './mime.js';

/**
 * Email sender authentication (docs/decisions/2026-09-29-cad-ingress-auth.md, "Email path").
 * Accept only when ALL hold:
 *  - SES verdicts: SPF PASS, DKIM PASS, spam not FAIL, virus not FAIL, DMARC not FAIL
 *    (DMARC GRAY - the sender publishes no policy - is accepted and recorded);
 *  - the RFC 5322 From is on the source's sender allowlist;
 *  - every DKIM signing domain (d=) is an allowlisted domain. Requiring EVERY signature, not
 *    one, closes the gap where SES's single DKIM verdict is PASS for an attacker's own valid
 *    signature while a forged one claims the allowlisted domain;
 *  - Date and every DKIM t= within 10 minutes of now.
 * There is no allowlist-only mode: a From header alone is trivially forged.
 */

export const EMAIL_FRESHNESS_SECONDS = 600;
export const EMAIL_REPLAY_TTL_SECONDS = 24 * 60 * 60;

export type EmailAuthFailure =
  | 'SpfFailed'
  | 'DkimFailed'
  | 'DmarcFailed'
  | 'Spam'
  | 'Virus'
  | 'SenderNotAllowed'
  | 'DkimDomainNotAllowed'
  | 'Stale';

export function checkSesVerdicts(receipt: SESReceipt): EmailAuthFailure | undefined {
  if (receipt.spfVerdict?.status !== 'PASS') return 'SpfFailed';
  if (receipt.dkimVerdict?.status !== 'PASS') return 'DkimFailed';
  if (receipt.virusVerdict?.status === 'FAIL') return 'Virus';
  if (receipt.spamVerdict?.status === 'FAIL') return 'Spam';
  if (receipt.dmarcVerdict?.status === 'FAIL') return 'DmarcFailed';
  return undefined;
}

function allowedDomains(allowedSenders: readonly string[]): Set<string> {
  return new Set(
    allowedSenders.map((entry) => (entry.includes('@') ? entry.split('@')[1]! : entry)),
  );
}

export function checkEmailSender(
  email: ParsedEmail,
  allowedSenders: readonly string[],
  nowSeconds: number,
): EmailAuthFailure | undefined {
  const domains = allowedDomains(allowedSenders);
  const fromAllowed =
    email.fromAddress !== undefined &&
    allowedSenders.some((entry) =>
      entry.includes('@') ? entry === email.fromAddress : entry === email.fromDomain,
    );
  if (!fromAllowed) return 'SenderNotAllowed';
  if (
    email.dkimSignatures.length === 0 ||
    email.dkimSignatures.some((signature) => !domains.has(signature.domain))
  ) {
    return 'DkimDomainNotAllowed';
  }
  const times = [email.date, ...email.dkimSignatures.map((signature) => signature.timestamp)];
  if (email.date === undefined) return 'Stale';
  if (
    times.some(
      (time) => time !== undefined && Math.abs(nowSeconds - time) > EMAIL_FRESHNESS_SECONDS,
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
