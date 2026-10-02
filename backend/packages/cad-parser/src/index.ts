import { createHash } from 'node:crypto';

/**
 * Per-source CAD dispatch parser (docs/decisions/2026-09-29-roadmap-defaults.md row 3).
 *
 * A department authors one template per CAD source: for each field, either a line label
 * ("ADDRESS" matches a line "ADDRESS: 123 MAIN ST") or a regular expression whose first
 * capture group is the value. The template is validated when it is saved, compiled once per
 * use, and carries a version so every dispatch records which template read it.
 *
 * Parsing FAILS OPEN: text the template cannot structure is still a dispatch, returned as
 * RAW so the caller pages with the raw text and "SEE DISPATCH TEXT". That is only safe
 * because the caller has already authenticated the sender (2026-09-29-cad-ingress-auth.md);
 * this package never decides trust.
 *
 * Shared by alerting (the ingress Lambdas) and the platform config route (validation and
 * the test-parse preview), so the preview is the same code that reads real dispatches.
 */

export const CAD_FIELDS = [
  'incidentNumber',
  'dispatchTime',
  'incidentType',
  'address',
  'crossStreets',
  'town',
  'units',
  'narrative',
] as const;

export type CadField = (typeof CAD_FIELDS)[number];

export interface CadFieldRule {
  /** Line label, matched case-insensitively at the start of a line, then ':' or '-'. */
  readonly label?: string;
  /** Regular expression (case-insensitive, multiline); the first capture group is the value. */
  readonly pattern?: string;
}

export interface CadParserTemplate {
  readonly version: number;
  readonly fields: Partial<Record<CadField, CadFieldRule>>;
}

export type CadParsedFields = Partial<Record<CadField, string>>;

export type CadParseResult =
  | { readonly status: 'PARSED'; readonly version: number; readonly fields: CadParsedFields }
  | {
      readonly status: 'RAW';
      readonly version: number | null;
      /** TIMEOUT / ERROR: the template ran past its deadline or failed (parseCadTextBounded). */
      readonly reason: 'NO_TEMPLATE' | 'NO_ADDRESS' | 'EMPTY' | 'TIMEOUT' | 'ERROR';
      readonly fields: CadParsedFields;
    };

export interface TemplateError {
  readonly field: string;
  readonly message: string;
}

/** The text a parser reads is capped: a regex never runs over more than this. */
export const MAX_PARSE_CHARS = 16_384;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_LABEL_LENGTH = 40;
const MAX_FIELD_CHARS = 500;
export const MAX_NARRATIVE_CHARS = 4_000;

/**
 * A quantified group that itself contains a quantifier - `(a+)+`, `(\w*)*`, `(x+){2,}` - is
 * the classic catastrophic-backtracking shape. JavaScript regexes have no timeout, so these
 * are refused when the template is saved rather than risk a stuck ingress Lambda.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 0x20);
}

/** Validates a template as saved by a chief. Unknown fields and keys are errors. */
export function validateCadParserTemplate(
  raw: unknown,
  prefix = 'parser',
): { ok: true; template: CadParserTemplate } | { ok: false; errors: TemplateError[] } {
  const errors: TemplateError[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: prefix, message: 'must be an object' }] };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'fields') {
      errors.push({ field: `${prefix}.${key}`, message: 'is not a recognized field' });
    }
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push({ field: `${prefix}.version`, message: 'must be a whole number from 1' });
  }
  const fields: Partial<Record<CadField, CadFieldRule>> = {};
  if (!isRecord(raw.fields)) {
    errors.push({ field: `${prefix}.fields`, message: 'must be an object' });
  } else {
    for (const [name, rule] of Object.entries(raw.fields)) {
      const where = `${prefix}.fields.${name}`;
      if (!(CAD_FIELDS as readonly string[]).includes(name)) {
        errors.push({ field: where, message: `is not one of ${CAD_FIELDS.join(', ')}` });
        continue;
      }
      if (!isRecord(rule)) {
        errors.push({ field: where, message: 'must be an object { label } or { pattern }' });
        continue;
      }
      for (const key of Object.keys(rule)) {
        if (key !== 'label' && key !== 'pattern') {
          errors.push({ field: `${where}.${key}`, message: 'is not a recognized field' });
        }
      }
      const { label, pattern } = rule;
      if ((label === undefined) === (pattern === undefined)) {
        errors.push({ field: where, message: 'needs exactly one of label or pattern' });
        continue;
      }
      if (label !== undefined) {
        if (
          typeof label !== 'string' ||
          label.trim().length === 0 ||
          label.length > MAX_LABEL_LENGTH ||
          hasControlCharacter(label)
        ) {
          errors.push({
            field: `${where}.label`,
            message: `must be 1-${MAX_LABEL_LENGTH} characters of text`,
          });
          continue;
        }
        fields[name as CadField] = { label: label.trim() };
        continue;
      }
      if (typeof pattern !== 'string' || pattern.length === 0) {
        errors.push({ field: `${where}.pattern`, message: 'must be a non-empty string' });
        continue;
      }
      if (pattern.length > MAX_PATTERN_LENGTH) {
        errors.push({
          field: `${where}.pattern`,
          message: `must be at most ${MAX_PATTERN_LENGTH} characters`,
        });
        continue;
      }
      if (NESTED_QUANTIFIER.test(pattern)) {
        errors.push({
          field: `${where}.pattern`,
          message: 'must not repeat a group that itself repeats, e.g. (a+)+ (it can hang)',
        });
        continue;
      }
      try {
        new RegExp(pattern, 'im');
      } catch {
        errors.push({ field: `${where}.pattern`, message: 'is not a valid regular expression' });
        continue;
      }
      fields[name as CadField] = { pattern };
    }
    if (!fields.address && !errors.some((e) => e.field.startsWith(`${prefix}.fields.address`))) {
      errors.push({
        field: `${prefix}.fields.address`,
        message: 'is required: a dispatch is structured only when its address is found',
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, template: { version: version as number, fields } };
}

/**
 * The whole extraction, as PLAIN JAVASCRIPT SOURCE (the body of a function of `rules`, `text`,
 * `limits`). Both paths evaluate this one string - in-thread through `new Function`, and in the
 * deadline worker (parseCadTextBounded) - so they cannot drift, and a bundler cannot rewrite it:
 * `Function.prototype.toString` of compiled code breaks under esbuild's keepNames, which
 * injects a module-level `__name` helper the worker does not have.
 */
const EXTRACT_SOURCE = String.raw`
  const escape = (value) => value.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&');
  const out = {};
  for (const [field, rule] of rules) {
    let raw;
    if (rule.label !== undefined) {
      const tail = field === 'narrative' ? '([\\s\\S]*)' : '([^\\n]*)';
      const m = new RegExp('^[ \\t]*' + escape(rule.label) + '[ \\t]*[:\\-][ \\t]*' + tail, 'im').exec(text);
      raw = m ? m[1] : undefined;
    } else if (rule.pattern !== undefined) {
      const m = new RegExp(rule.pattern, 'im').exec(text);
      raw = m ? (m[1] !== undefined ? m[1] : m[0]) : undefined;
    }
    if (raw === undefined) continue;
    const isNarrative = field === 'narrative';
    const cleaned = (isNarrative ? raw.replace(/[ \t]+/g, ' ') : raw.replace(/\s+/g, ' ')).trim();
    if (cleaned.length > 0) out[field] = cleaned.slice(0, isNarrative ? limits.narrative : limits.field);
  }
  return out;
`;

type Extract = (
  rules: readonly (readonly [string, CadFieldRule])[],
  text: string,
  limits: { readonly field: number; readonly narrative: number },
) => Record<string, string>;

// eslint-disable-next-line @typescript-eslint/no-implied-eval -- a fixed, reviewed source string
export const extractCadFields = new Function('rules', 'text', 'limits', EXTRACT_SOURCE) as Extract;

const FIELD_LIMITS = { field: MAX_FIELD_CHARS, narrative: MAX_NARRATIVE_CHARS } as const;

function toResult(version: number, fields: CadParsedFields): CadParseResult {
  return fields.address
    ? { status: 'PARSED', version, fields }
    : { status: 'RAW', version, reason: 'NO_ADDRESS', fields };
}

/** CRLF to LF, NUL and other control characters (except tab/newline) removed, capped. */
export function normalizeDispatchText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, MAX_PARSE_CHARS)
  );
}

export interface CompiledCadParser {
  readonly version: number;
  parse(text: string): CadParseResult;
}

export function compileCadParser(template: CadParserTemplate): CompiledCadParser {
  const rules = Object.entries(template.fields) as [CadField, CadFieldRule][];
  // Compile once up front so an invalid pattern throws here, not per message.
  for (const [, rule] of rules) if (rule.pattern !== undefined) new RegExp(rule.pattern, 'im');
  return {
    version: template.version,
    parse(text: string): CadParseResult {
      const normalized = normalizeDispatchText(text);
      if (normalized.trim().length === 0) {
        return { status: 'RAW', version: template.version, reason: 'EMPTY', fields: {} };
      }
      return toResult(template.version, extractCadFields(rules, normalized, FIELD_LIMITS));
    },
  };
}

/** Parse with an optional template: no template is a RAW result, never an error. */
export function parseCadText(
  template: CadParserTemplate | undefined,
  text: string,
): CadParseResult {
  if (!template) {
    return {
      status: 'RAW',
      version: null,
      reason: normalizeDispatchText(text).trim().length === 0 ? 'EMPTY' : 'NO_TEMPLATE',
      fields: {},
    };
  }
  return compileCadParser(template).parse(text);
}

/**
 * A stable fingerprint of dispatch text: whitespace-insensitive, so a resend that re-wraps
 * lines or changes line endings still collapses to the same dispatch.
 */
export function dispatchTextFingerprint(text: string): string {
  const collapsed = normalizeDispatchText(text).replace(/\s+/g, ' ').trim().toUpperCase();
  return createHash('sha256').update(collapsed, 'utf8').digest('hex');
}

/** A template's total time budget per message, worker start-up included (security review M3). */
export const PARSE_DEADLINE_MS = 500;

/**
 * parseCadText with a HARD deadline: the template's regular expressions run in a worker thread
 * that is terminated when the deadline passes, and the result is RAW (reason TIMEOUT) - the
 * dispatch still pages as raw text. JavaScript regexes cannot be interrupted in-thread, and the
 * save-time lint (NESTED_QUANTIFIER) is bypassable (`((a)+)+$`, `(a|a)*$`), so this is the
 * control; the lint only catches mistakes early. Never rejects.
 */
export async function parseCadTextBounded(
  template: CadParserTemplate | undefined,
  text: string,
  deadlineMs = PARSE_DEADLINE_MS,
): Promise<CadParseResult> {
  const normalized = normalizeDispatchText(text);
  if (!template || normalized.trim().length === 0) return parseCadText(template, text);
  const { Worker } = await import('node:worker_threads');
  const source = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    `const extractCadFields = new Function('rules', 'text', 'limits', ${JSON.stringify(EXTRACT_SOURCE)});`,
    'parentPort.postMessage(extractCadFields(workerData.rules, workerData.text, workerData.limits));',
  ].join('\n');
  return new Promise<CadParseResult>((resolve) => {
    let settled = false;
    const finish = (result: CadParseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        rules: Object.entries(template.fields),
        text: normalized,
        limits: FIELD_LIMITS,
      },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    const timer = setTimeout(
      () => finish({ status: 'RAW', version: template.version, reason: 'TIMEOUT', fields: {} }),
      deadlineMs,
    );
    worker.once('message', (fields: CadParsedFields) => finish(toResult(template.version, fields)));
    worker.once('error', () =>
      finish({ status: 'RAW', version: template.version, reason: 'ERROR', fields: {} }),
    );
    worker.once('exit', () =>
      finish({ status: 'RAW', version: template.version, reason: 'ERROR', fields: {} }),
    );
  });
}

/**
 * A CAD message time, resolved for ORDERING updates of one incident (chain review R3-M1:
 * `Date.parse("2355")` is the year 2355 and `"0003"` the year 3, so every correction after
 * midnight looked older than the original). Only two shapes are trusted:
 *  - a full date and time (MM/DD/YYYY or YYYY-MM-DD, then HH:MM[:SS]), read in the
 *    department's time zone, accepted only within 24 h of the message's receipt;
 *  - a bare time of day (HHMM, HH:MM, HHMMSS, HH:MM:SS), placed on the day before, of, or after
 *    THIS message's receipt (in the department's time zone), whichever is nearest the receipt.
 *    CAD messages arrive within minutes of their stamp, so the nearest reading is the right
 *    one however long the incident has run (chain review R3b-M1: anchoring on the last
 *    applied message read an update 13.5 h later as a day early).
 * A wall time that occurs twice (the repeated hour on the DST fall-back night) takes the
 * instant nearest the receipt, too (R3b-M1: `0110` EST after `0150` EDT is 20 minutes later,
 * not 40 earlier). Anything else is undefined: unordered, applied in arrival order.
 */
export function resolveCadMessageTime(
  text: string | undefined,
  options: {
    readonly receivedAt: number;
    readonly timeZone: string;
  },
): number | undefined {
  if (!text) return undefined;
  const value = text.trim();
  const { receivedAt, timeZone } = options;
  const within = (epoch: number | undefined) =>
    epoch !== undefined && Math.abs(epoch - receivedAt) <= 24 * 3600 ? epoch : undefined;

  const bare = /^(\d{1,2}):?(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (bare) {
    const [hour, minute, second] = [Number(bare[1]), Number(bare[2]), Number(bare[3] ?? 0)];
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    const today = zonedParts(receivedAt, timeZone);
    const candidates = [-1, 0, 1].flatMap((offsetDays) => {
      const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
      return zonedInstants(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        minute,
        second,
        timeZone,
      );
    });
    return within(nearest(candidates, receivedAt));
  }

  const full =
    /^(?:(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})|(\d{4})-(\d{2})-(\d{2}))[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      value,
    );
  if (!full) return undefined;
  const year = full[4] ? Number(full[4]) : Number(full[3]!.length === 2 ? `20${full[3]}` : full[3]);
  const month = Number(full[4] ? full[5] : full[1]);
  const day = Number(full[4] ? full[6] : full[2]);
  const [hour, minute, second] = [Number(full[7]), Number(full[8]), Number(full[9] ?? 0)];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  return within(
    nearest(zonedInstants(year, month, day, hour, minute, second, timeZone), receivedAt),
  );
}

function nearest(candidates: readonly number[], target: number): number | undefined {
  let best: number | undefined;
  for (const candidate of candidates) {
    if (best === undefined || Math.abs(candidate - target) < Math.abs(best - target)) {
      best = candidate;
    }
  }
  return best;
}

function zonedParts(epoch: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's UTC offset (seconds) at an instant. */
function offsetAt(epoch: number, timeZone: string): number {
  const seen = zonedParts(epoch, timeZone);
  const wall =
    Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) / 1000;
  return wall - epoch;
}

/**
 * Every instant at which the wall clock in `timeZone` reads this time: usually one, two in the
 * repeated fall-back hour. A time skipped at spring-forward has none; it is then read with the
 * offset in force before the gap (the clock a CAD that did not jump yet would show).
 */
function zonedInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number[] {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  // Any DST transition near this wall time lies within a day of it: the offsets before and
  // after are the only ones that can apply.
  const offsets = [
    ...new Set([offsetAt(wall - 86400, timeZone), offsetAt(wall + 86400, timeZone)]),
  ];
  const instants = offsets
    .map((offset) => wall - offset)
    .filter((epoch) => offsetAt(epoch, timeZone) + epoch === wall);
  return instants.length > 0 ? instants : [wall - offsets[0]!];
}

/** A valid IANA time zone name? */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_CAD_TIME_ZONE = 'America/New_York';
