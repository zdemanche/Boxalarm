/**
 * Just enough RFC 5322 / MIME to read a CAD dispatch email: the headers the sender checks
 * need (From, Date, Message-ID, DKIM-Signature) and the first text part of the body. SES has
 * already verified DKIM and SPF; nothing here decides trust - it only reads the values the
 * allowlist and replay checks compare.
 */

export interface DkimSignature {
  /** Signing domain (d=), lower case. */
  readonly domain: string;
  /** Signature (b=), whitespace removed. */
  readonly signature: string;
  /** Signing time (t=), epoch seconds, when present. */
  readonly timestamp?: number;
}

export interface ParsedEmail {
  readonly fromAddress: string | undefined;
  readonly fromDomain: string | undefined;
  readonly date: number | undefined;
  readonly messageId: string | undefined;
  /** Decoded Subject: many CADs put the call type and address there (chain review C1). */
  readonly subject: string | undefined;
  readonly dkimSignatures: readonly DkimSignature[];
  readonly text: string;
}

type Headers = readonly (readonly [string, string])[];

function splitMessage(raw: string): { headerBlock: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  return match
    ? { headerBlock: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) }
    : { headerBlock: raw, body: '' };
}

function parseHeaders(block: string): Headers {
  const headers: [string, string][] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1]!;
      last[1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

function all(headers: Headers, name: string): string[] {
  return headers.filter(([key]) => key === name).map(([, value]) => value);
}

function first(headers: Headers, name: string): string | undefined {
  return all(headers, name)[0];
}

/** `"Dispatch" <cad@county.gov>` or `cad@county.gov` -> the address, lower case. */
export function parseAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const bare = angle?.[1] ?? /([^\s<>",;]+@[^\s<>",;]+)/.exec(value)?.[1];
  return bare?.toLowerCase();
}

export function parseDkimSignature(value: string): DkimSignature | undefined {
  const tags = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const domain = tags.get('d')?.toLowerCase();
  const signature = tags.get('b')?.replace(/\s+/g, '');
  if (!domain || !signature) return undefined;
  const t = tags.get('t');
  return {
    domain,
    signature,
    ...(t && /^\d{1,12}$/.test(t) ? { timestamp: Number(t) } : {}),
  };
}

function parameter(headerValue: string | undefined, name: string): string | undefined {
  if (!headerValue) return undefined;
  const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(headerValue);
  return match?.[1] ?? match?.[2];
}

function decodeQuotedPrintable(text: string): Buffer {
  const soft = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, headers: Headers): string {
  const encoding = first(headers, 'content-transfer-encoding')?.toLowerCase();
  const charset = parameter(first(headers, 'content-type'), 'charset')?.toLowerCase();
  const bytes =
    encoding === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : encoding === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, 'latin1');
  const latin = charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252';
  return bytes.toString(latin ? 'latin1' : 'utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** The first text/plain part (depth-first), else the first text/html part as text. */
function extractText(headers: Headers, body: string, depth = 0): { plain?: string; html?: string } {
  const contentType = first(headers, 'content-type') ?? 'text/plain';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = parameter(contentType, 'boundary');
    if (!boundary) return {};
    const parts = body.split(`--${boundary}`).slice(1);
    let html: string | undefined;
    for (const part of parts) {
      if (part.startsWith('--')) break;
      const { headerBlock, body: partBody } = splitMessage(part.replace(/^\r?\n/, ''));
      const found = extractText(parseHeaders(headerBlock), partBody, depth + 1);
      if (found.plain !== undefined) return found;
      html ??= found.html;
    }
    return html !== undefined ? { html } : {};
  }
  if (type === 'text/plain') return { plain: decodeBody(body, headers) };
  if (type === 'text/html') return { html: stripHtml(decodeBody(body, headers)) };
  return {};
}

/** RFC 2047 encoded-words (=?charset?B|Q?text?=) in a header value, decoded; others kept. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g,
      (whole, charset: string, enc: string, text: string) => {
        const latin = /^(iso-8859-1|latin1|windows-1252)$/i.test(charset);
        if (!latin && !/^(utf-8|us-ascii)$/i.test(charset)) return whole;
        const bytes =
          enc.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : decodeQuotedPrintable(text.replace(/_/g, ' '));
        return bytes.toString(latin ? 'latin1' : 'utf8');
      },
    );
}

export function parseEmail(raw: string): ParsedEmail {
  const { headerBlock, body } = splitMessage(raw);
  const headers = parseHeaders(headerBlock);
  const fromAddress = parseAddress(first(headers, 'from'));
  const dateHeader = first(headers, 'date');
  const date = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  const found = extractText(headers, body);
  return {
    fromAddress,
    fromDomain: fromAddress?.split('@')[1],
    date: Number.isFinite(date) ? Math.floor(date / 1000) : undefined,
    messageId: first(headers, 'message-id'),
    subject: ((subject) => (subject ? decodeEncodedWords(subject).trim() || undefined : undefined))(
      first(headers, 'subject'),
    ),
    dkimSignatures: all(headers, 'dkim-signature')
      .map(parseDkimSignature)
      .filter((sig): sig is DkimSignature => sig !== undefined),
    text: (found.plain ?? found.html ?? '').trim(),
  };
}
