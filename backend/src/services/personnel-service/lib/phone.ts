/**
 * Member phone numbers are stored in E.164 (`+12705550142`). The alerting plane sends SMS pages
 * and voice escalations to exactly this string; a national format such as "(270) 555-0142"
 * reached the SMS/voice vendor verbatim and was refused on every page (review MAJOR-3).
 *
 * The default country is the US (NANP). Accepted:
 *  - E.164 as is, spacing and punctuation allowed: "+1 270 555 0142", "+44 20 7946 0018";
 *  - a 10-digit NANP number in any common format: "(270) 555-0142", "270.555.0142";
 *  - an 11-digit NANP number with its leading 1: "1-270-555-0142".
 * A NANP number must have an area code and an exchange that do not start with 0 or 1.
 * Anything else is rejected - never guessed at.
 *
 * The alerting plane keeps its own copy of these rules (eligibility/phone.ts) so the two planes
 * never import each other; channels/phoneNormalization.contract.test.ts keeps them in step.
 */
const SEPARATORS = /[\s().-]/g;
const NANP = /^([2-9]\d{2})([2-9]\d{2})(\d{4})$/;

export function normalizePhoneE164(raw: string): string | undefined {
  const compact = raw.trim().replace(SEPARATORS, '');
  if (compact.startsWith('+')) {
    const digits = compact.slice(1);
    if (!/^[1-9]\d{7,14}$/.test(digits)) {
      return undefined;
    }
    if (digits.startsWith('1') && !NANP.test(digits.slice(1))) {
      return undefined;
    }
    return `+${digits}`;
  }
  if (!/^\d+$/.test(compact)) {
    return undefined;
  }
  const national = compact.length === 11 && compact.startsWith('1') ? compact.slice(1) : compact;
  return NANP.test(national) ? `+1${national}` : undefined;
}

export const INVALID_PHONE_MESSAGE =
  'phone must be a US number such as (270) 555-0142, or an international number starting with +';
