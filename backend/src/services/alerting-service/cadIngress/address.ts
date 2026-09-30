/**
 * RFC 5322 `From` header parsing for sender authentication (security review C1).
 *
 * The earlier parser returned the first `<local@domain>` anywhere in the header value -
 * including inside a quoted display name or a comment - so `"<dispatch@county.gov>"
 * <clerk@county.gov>` read as the allowlisted dispatch address while SES and DMARC evaluated the
 * real mailbox, clerk@. This parser follows the grammar instead:
 *   from        = mailbox-list        (exactly ONE mailbox accepted here)
 *   mailbox     = name-addr / addr-spec
 *   name-addr   = [display-name] "<" addr-spec ">"
 * Quoted strings and (nested) comments are consumed as such, never searched for addresses;
 * a group (`name: ...;`), more than one mailbox, more than one angle-addr, or anything that is
 * not a plain dot-atom addr-spec is refused. No dependency: the grammar needed is small, and
 * every accepted and refused shape is pinned by address.test.ts.
 */

export type FromParse =
  | { readonly ok: true; readonly address: string; readonly domain: string }
  | { readonly ok: false; readonly reason: string };

const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOT_ATOM = `${ATEXT}+(?:\\.${ATEXT}+)*`;
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const ADDR_SPEC = new RegExp(`^(${DOT_ATOM})@(${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+)$`);

interface Scan {
  /** The value with quoted strings replaced by `"…"` placeholders and comments removed. */
  readonly skeleton: string;
  /** Top-level angle-addr contents, in order. */
  readonly angles: string[];
  readonly error?: string;
}

function scan(value: string): Scan {
  let skeleton = '';
  const angles: string[] = [];
  let depth = 0;
  let inQuote = false;
  let angle: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inQuote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (depth > 0) {
      if (ch === '\\') {
        i++;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      continue;
    }
    if (ch === '(') {
      depth = 1;
      skeleton += ' ';
      continue;
    }
    if (angle !== null) {
      if (ch === '>') {
        angles.push(angle);
        angle = null;
        skeleton += '<>';
      } else if (ch === '<' || ch === '"') {
        return { skeleton, angles, error: 'MalformedAngleAddr' };
      } else {
        angle += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      skeleton += '"…"';
      continue;
    }
    if (ch === '<') {
      angle = '';
      continue;
    }
    if (ch === '>') return { skeleton, angles, error: 'MalformedAngleAddr' };
    skeleton += ch;
  }
  if (inQuote || depth > 0 || angle !== null) {
    return { skeleton, angles, error: 'Unterminated' };
  }
  return { skeleton, angles };
}

function addrSpec(text: string): FromParse {
  const match = ADDR_SPEC.exec(text.trim());
  if (!match) return { ok: false, reason: 'NotAnAddress' };
  const address = `${match[1]!}@${match[2]!}`.toLowerCase();
  return { ok: true, address, domain: match[2]!.toLowerCase() };
}

/** One `From` header value -> its single mailbox, or why it is refused. */
export function parseFromHeader(value: string): FromParse {
  if (/[\r\n]/.test(value)) return { ok: false, reason: 'BareLineBreak' };
  const { skeleton, angles, error } = scan(value);
  if (error) return { ok: false, reason: error };
  if (skeleton.includes(',')) return { ok: false, reason: 'MultipleMailboxes' };
  if (skeleton.includes(':') || skeleton.includes(';')) return { ok: false, reason: 'Group' };
  if (angles.length > 1) return { ok: false, reason: 'MultipleMailboxes' };
  if (angles.length === 1) {
    // name-addr: nothing may follow the angle-addr but whitespace.
    const after = skeleton.slice(skeleton.indexOf('<>') + 2);
    if (after.trim().length > 0) return { ok: false, reason: 'TrailingText' };
    const before = skeleton.slice(0, skeleton.indexOf('<>'));
    if (before.includes('@')) return { ok: false, reason: 'AddressInDisplayName' };
    return addrSpec(angles[0]!);
  }
  // addr-spec alone (comments already removed; a quoted local part is refused).
  if (skeleton.includes('"')) return { ok: false, reason: 'QuotedLocalPart' };
  return addrSpec(skeleton);
}

/** Every `From` header of the message -> the single mailbox, or why it is refused. */
export function parseFromHeaders(values: readonly string[]): FromParse {
  if (values.length === 0) return { ok: false, reason: 'NoFrom' };
  if (values.length > 1) return { ok: false, reason: 'MultipleFromHeaders' };
  return parseFromHeader(values[0]!);
}

/**
 * DMARC-style relaxed alignment of a DKIM signing domain with the From domain, without a
 * public-suffix list: equal, or one a subdomain of the other, where the shorter has at least
 * two labels (so `d=gov` never aligns with every `.gov` mailbox).
 */
export function isAligned(signingDomain: string, fromDomain: string): boolean {
  const d = signingDomain.toLowerCase();
  const f = fromDomain.toLowerCase();
  if (d === f) return true;
  const [shorter, longer] = d.length < f.length ? [d, f] : [f, d];
  return shorter.split('.').length >= 2 && longer.endsWith(`.${shorter}`);
}
